import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CloudflareApiError, CloudflareClient } from "../src/cloudflare/client";
import { runDeployCommand } from "../src/commands/deploy";
import {
  deployArtifactShare,
  describeCloudflareFailure,
  deploymentPlan,
  type DeployInput,
} from "../src/cloudflare/deployment";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const input: DeployInput = {
  accountId,
  zoneId,
  hostname: "artifacts.example.com",
  identities: [{ kind: "domain", value: "example.com" }],
  pdfKeyId: "test-key",
  pdfPublicKey: `${"A".repeat(43)}=`,
  dryRun: false,
};

const deploymentRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "artifact-share-deployment-test-"));
  await writeFile(resolve(root, "wrangler-template.json"), JSON.stringify({
    name: "template",
    main: "./index.js",
    assets: { directory: "./client" },
    vars: {},
    d1_databases: [{}],
    r2_buckets: [{}],
  }));
  await writeFile(resolve(root, "storage-lifecycle.json"), "{}");
  return root;
};

const fakeClient = (options: {
  collision?: boolean;
  existing?: boolean;
  forbidden?: boolean;
  failR2?: boolean;
} = {}) => {
  const requests: { path: string; init: RequestInit }[] = [];
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init });
    if (options.forbidden && path.includes("/d1/")) {
      const error = new Error("forbidden") as Error & { status: number };
      error.status = 403;
      throw error;
    }
    if (path === "/user/tokens/verify") return { status: "active" };
    if (path === `/zones/${zoneId}`) return { name: "example.com", status: "active" };
    if (path.includes("/d1/database?")) return options.existing ? [{ uuid: "db-id", name: "lordebuilds-artifacts-share" }] : [];
    if (path.endsWith("/d1/database")) return { uuid: "db-id", name: "lordebuilds-artifacts-share" };
    if (path.endsWith("/r2/buckets") && init.method !== "POST") {
      return { buckets: options.existing ? [{ name: "lordebuilds-artifacts-share" }] : [] };
    }
    if (path.endsWith("/r2/buckets") && init.method === "POST" && options.failR2 === true) {
      throw new Error("R2 provisioning failed");
    }
    if (path.endsWith("/access/organizations")) return { auth_domain: "team.cloudflareaccess.com" };
    if (path.endsWith("/access/apps") && init.method !== "POST") {
      return options.existing ? [{
        id: "app-id",
        name: "lordebuilds-artifacts-share",
        aud: "audience",
        destinations: [
          { type: "public", uri: "artifacts.example.com/upload*" },
          { type: "public", uri: "artifacts.example.com/connect/approve*" },
        ],
      }] : [];
    }
    if (path.endsWith("/access/apps") && init.method === "POST") {
      return { id: "app-id", name: "lordebuilds-artifacts-share", aud: "audience" };
    }
    if (path.endsWith("/policies")) {
      return options.existing ? [{
        id: "policy-id",
        name: "Artifact Share uploaders",
        include: [{ email_domain: { domain: "example.com" } }],
      }] : [];
    }
    if (path.endsWith("/workers/domains")) {
      return options.collision ? [{ hostname: "artifacts.example.com", service: "other" }] : [];
    }
    return {};
  });
  return {
    client: { request, verifyToken: () => request("/user/tokens/verify") } as unknown as CloudflareClient,
    requests,
  };
};

describe("Cloudflare deployment", () => {
  it("uses the versioned Cloudflare API origin and bearer authentication", async () => {
    const fetch = vi.fn(async (_request: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      success: true,
      result: { status: "active" },
    })));
    const client = new CloudflareClient({ token: "cloudflare-secret", fetch });
    await client.verifyToken();
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const [request, init] = call ?? ["", undefined];
    expect(String(request)).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cloudflare-secret");
  });

  it("turns permission denials into the least-privilege checklist", () => {
    const message = describeCloudflareFailure(new CloudflareApiError("forbidden", 403));
    expect(message).toContain("Workers Scripts Write");
    expect(message).toContain("Access: Apps and Policies Write");
    expect(message).toContain("Access: Organizations, Identity Providers, and Groups Read");
  });

  it("plans a complete deployment without mutations or credentials", async () => {
    const client = fakeClient();
    const result = await deployArtifactShare({ ...input, dryRun: true }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner: vi.fn(),
    });
    expect(result.plan).toHaveLength(7);
    expect(result.plan[3]).toContain("prepare the Worker configuration");
    expect(result.plan[4]).toContain("apply D1 migrations");
    expect(result.plan[5]).toContain("deploy the Worker");
    expect(result.changed).toEqual([]);
    expect(client.requests).toEqual([]);
    expect(result.teamCommand).toContain("connect https://artifacts.example.com");
  });

  it("runs the command-level dry-run without credentials, processes, or network calls", async () => {
    const runner = vi.fn();
    const fetch = vi.fn();
    const result = await runDeployCommand({ ...input, dryRun: true }, {
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch,
    });
    expect(result.changed).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes an authenticated state-bound approval manifest without mutations", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "approval.json");
    const client = fakeClient({ existing: true });
    const runner = vi.fn();
    const result = await deployArtifactShare({
      ...input,
      writeApprovalManifest: manifestPath,
    }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    });

    expect(result.approvalManifest).toBe(manifestPath);
    expect(result.changed).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      version: 1,
      binding: {
        input: { hostname: "artifacts.example.com", pdfKeyId: "test-key" },
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        remote: { database: { uuid: "db-id" } },
      },
    });
  });

  it("aborts before mutation when an approved bundle changes", async () => {
    const root = await deploymentRoot();
    const manifestPath = resolve(root, "approval.json");
    const client = fakeClient({ existing: true });
    await deployArtifactShare({ ...input, writeApprovalManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
    });
    await writeFile(resolve(root, "storage-lifecycle.json"), "{\"changed\":true}");
    const runner = vi.fn();

    await expect(deployArtifactShare({ ...input, approveManifest: manifestPath }, {
      client: client.client,
      deploymentRoot: root,
      runner,
    })).rejects.toThrow("no longer matches");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects missing identity, invalid IDs, and a hostname outside the zone", async () => {
    expect(() => deploymentPlan({ ...input, identities: [] })).toThrow("allowed identity");
    expect(() => deploymentPlan({ ...input, accountId: "wrong" })).toThrow("32 lowercase");
    const client = fakeClient();
    await expect(deployArtifactShare({ ...input, hostname: "artifacts.foreign.com" }, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
    })).rejects.toThrow("selected active");
  });

  it("accepts the active zone apex as the Worker Custom Domain", async () => {
    const root = await deploymentRoot();
    const client = fakeClient({ existing: true });
    await expect(deployArtifactShare({
      ...input,
      hostname: "example.com",
      writeApprovalManifest: resolve(root, "apex-approval.json"),
    }, {
      client: client.client,
      deploymentRoot: root,
    })).resolves.toMatchObject({ changed: [] });
  });

  it("refuses a custom-hostname collision before running Wrangler", async () => {
    const client = fakeClient({ collision: true, existing: true });
    const runner = vi.fn();
    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("already attached");
    expect(runner).not.toHaveBeenCalled();
  });

  it("surfaces partial provisioning and leaves the rerunnable named D1 resource", async () => {
    const client = fakeClient({ failR2: true });
    const runner = vi.fn();
    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("R2 provisioning failed");
    expect(client.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `/accounts/${accountId}/d1/database`,
        init: expect.objectContaining({ method: "POST" }),
      }),
    ]));
    expect(runner).not.toHaveBeenCalled();
  });

  it("reuses existing resources and reruns deployment safely", async () => {
    const client = fakeClient({ existing: true });
    const commands: string[][] = [];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      commands.push([...args]);
      return { stdout: "", stderr: "" };
    });
    const result = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch: vi.fn(async (request) => String(request).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })),
    });
    expect(result.changed).toEqual(["Worker deployment"]);
    const rerun = await deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
      fetch: vi.fn(async (request) => String(request).endsWith("/health")
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(null, { status: 302 })),
    });
    expect(rerun.changed).toEqual(["Worker deployment"]);
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ["d1", "migrations", "apply"],
      ["r2", "bucket", "lifecycle"],
      ["deploy", "--config", expect.any(String)],
      ["d1", "migrations", "apply"],
      ["r2", "bucket", "lifecycle"],
      ["deploy", "--config", expect.any(String)],
    ]);
  });

  it("surfaces migration failure and never writes a provisioning token into command arguments", async () => {
    const client = fakeClient({ existing: true });
    const seen: readonly string[][] = [];
    const mutableSeen = seen as string[][];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      mutableSeen.push([...args]);
      if (args[0] === "d1") throw new Error("migration failed");
      return { stdout: "", stderr: "" };
    });
    await expect(deployArtifactShare(input, {
      client: client.client,
      deploymentRoot: await deploymentRoot(),
      runner,
    })).rejects.toThrow("migration failed");
    expect(JSON.stringify(mutableSeen)).not.toContain("cloudflare-secret");
  });
});
