import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CloudflareClient } from "../src/cloudflare/client";
import { activatePublicArtifactPass } from "../src/cloudflare/public-activation";

const accountId = "a".repeat(32);
const hostname = "artifactpass.com";
const application = {
  id: "access-app-id",
  name: "lordebuilds-artifacts-share",
  destinations: [
    { type: "public", uri: `${hostname}/upload*` },
    { type: "public", uri: `${hostname}/connect/approve*` },
  ],
};
const policy = { id: "allow-id", name: "Artifact Share uploaders", decision: "allow", include: [] };

const fakeClient = () => {
  const requests: { readonly path: string; readonly init: RequestInit }[] = [];
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init });
    if (path === "/user/tokens/verify") return { status: "active" };
    if (path.endsWith("/access/apps")) return [application];
    if (path.endsWith("/policies") && init.method === undefined) return [policy];
    if (path.endsWith("/policies") && init.method === "POST") return { id: "bypass-id" };
    return {};
  });
  return {
    client: { request, verifyToken: () => request("/user/tokens/verify") } as unknown as CloudflareClient,
    requests,
  };
};

describe("public activation", () => {
  it("creates one reversible bypass policy from an unchanged approval", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-activation-test-"));
    const manifestPath = resolve(root, "approval.json");
    const cloudflare = fakeClient();
    await activatePublicArtifactPass({ accountId, hostname, writeApprovalManifest: manifestPath }, {
      client: cloudflare.client,
    });
    expect((await readFile(manifestPath, "utf8"))).toContain('"access-app-id"');

    const result = await activatePublicArtifactPass({ accountId, hostname, approveManifest: manifestPath }, {
      client: cloudflare.client,
      fetch: vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: "https://artifactpass.com/auth/sign-in?return_to=%2Fupload" },
      })),
    });

    expect(result).toMatchObject({ changed: ["Access bypass policy"], activationPolicyId: "bypass-id" });
    expect(cloudflare.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/access-app-id/policies`,
      init: expect.objectContaining({ method: "POST" }),
    }));
  });

  it("refuses stale approval state before mutation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-activation-test-"));
    const manifestPath = resolve(root, "approval.json");
    const cloudflare = fakeClient();
    await activatePublicArtifactPass({ accountId, hostname, writeApprovalManifest: manifestPath }, {
      client: cloudflare.client,
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.binding.accessApplication.id = "stale-id";
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(activatePublicArtifactPass({ accountId, hostname, approveManifest: manifestPath }, {
      client: cloudflare.client,
    })).rejects.toThrow("no longer matches");
    expect(cloudflare.requests.some(({ init }) => init.method === "POST")).toBe(false);
  });

  it("removes the bypass policy when public verification fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-activation-test-"));
    const manifestPath = resolve(root, "approval.json");
    const cloudflare = fakeClient();
    await activatePublicArtifactPass({ accountId, hostname, writeApprovalManifest: manifestPath }, {
      client: cloudflare.client,
    });

    await expect(activatePublicArtifactPass({ accountId, hostname, approveManifest: manifestPath }, {
      client: cloudflare.client,
      fetch: vi.fn(async () => new Response("still contained", { status: 403 })),
      sleep: vi.fn(async () => undefined),
    })).rejects.toThrow("containment was restored");
    expect(cloudflare.requests).toContainEqual(expect.objectContaining({
      path: `/accounts/${accountId}/access/apps/access-app-id/policies/bypass-id`,
      init: expect.objectContaining({ method: "DELETE" }),
    }));
  });
});
