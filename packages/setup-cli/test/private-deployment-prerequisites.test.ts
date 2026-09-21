import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CloudflareApiError, type CloudflareClient } from "../src/cloudflare/client";
import type { BrowserHandoffPrompt } from "../src/private-deployment/browser-handoff";
import { runPrivateDeploymentPrerequisites } from "../src/private-deployment/prerequisites";
import {
  createPrivateDeploymentState,
  writePrivateDeploymentState,
  type PrivateDeploymentState,
} from "../src/private-deployment/deployment-state";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const now = new Date("2026-09-01T20:00:00.000Z");

const state: PrivateDeploymentState = {
  schema_version: 1,
  deployment_id: "11111111-1111-4111-8111-111111111111",
  created_by_cli_version: "0.1.0-rc.12",
  last_written_by_cli_version: "0.1.0-rc.12",
  status: "incomplete",
  stage: "cloudflare-authorized",
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
  registrar_authority_confirmed: true,
  sign_in_mode: "company-login",
  checkpoints: {},
};

const promptWith = (answers: readonly string[]): { prompt: BrowserHandoffPrompt; output: string[] } => {
  const queue = [...answers];
  const output: string[] = [];
  return {
    prompt: {
      question: async (message) => {
        output.push(message);
        return queue.shift() ?? "3";
      },
      write: (message) => output.push(message),
    },
    output,
  };
};

const clientFor = (options: { r2?: "ready" | "pending"; zeroTrust?: "ready" | "pending"; worker?: "ready" | "absent"; zone?: "active" | "pending" } = {}): CloudflareClient => ({
  request: vi.fn(async (path: string) => {
    if (path.startsWith("/accounts?")) return [{ id: accountId, name: "Example Company" }];
    if (path.startsWith("/zones?")) return [{
      id: zoneId,
      name: "example.com",
      status: options.zone ?? "active",
      account: { id: accountId },
      name_servers: ["one.ns.cloudflare.com", "two.ns.cloudflare.com"],
    }];
    if (path.includes("/d1/")) return [];
    if (path.includes("/r2/")) {
      if (options.r2 === "pending") throw new CloudflareApiError("R2 subscription is not enabled", 403);
      return { buckets: [] };
    }
    if (path.endsWith("/access/organizations")) {
      if (options.zeroTrust === "pending") throw new CloudflareApiError("not found", 404);
      return { auth_domain: "example.cloudflareaccess.com" };
    }
    if (path.endsWith("/workers/subdomain")) {
      if (options.worker === "absent") throw new CloudflareApiError("not found", 404);
      return { subdomain: "example-workers" };
    }
    throw new Error(`Unexpected request: ${path}`);
  }),
}) as unknown as CloudflareClient;

describe("private deployment prerequisite flow", () => {
  it("reaches ready using an active account, zone, R2, Zero Trust, and Workers subdomain", async () => {
    const persistedStages: string[] = [];
    const result = await runPrivateDeploymentPrerequisites(state, {
      client: clientFor(),
      prompt: promptWith(["1"]).prompt,
      openBrowser: vi.fn(),
      now: () => now,
      persist: async (nextState) => {
        persistedStages.push(nextState.stage);
        return nextState;
      },
    });
    expect(result.status).toBe("ready");
    expect(result.state).toMatchObject({
      stage: "prerequisites-ready",
      cloudflare: {
        account_id: accountId,
        account_name: "Example Company",
        zone_id: zoneId,
        zone_name: "example.com",
      },
      resources: {
        placement: "automatic",
        workers_subdomain: "example-workers",
        workers_subdomain_action: "reuse",
      },
    });
    expect(persistedStages).toEqual(["account-selected", "zone-active", "prerequisites-ready"]);
  });

  it("saves a pending domain handoff without changing Cloudflare", async () => {
    const interaction = promptWith(["1", "3"]);
    const client = clientFor({ zone: "pending" });
    const persisted: PrivateDeploymentState[] = [];
    const result = await runPrivateDeploymentPrerequisites(state, {
      client,
      prompt: interaction.prompt,
      openBrowser: vi.fn(),
      now: () => now,
      persist: async (nextState) => {
        persisted.push(structuredClone(nextState));
        return nextState;
      },
    });
    expect(result.status).toBe("saved");
    expect(result.state.pending_handoff).toMatchObject({ kind: "domain" });
    expect(persisted).toContainEqual(expect.objectContaining({
      cloudflare: expect.objectContaining({ zone_name: "example.com" }),
      pending_handoff: expect.objectContaining({ kind: "domain" }),
    }));
    expect(interaction.output.join("\n")).toContain("update those nameservers at your registrar");
    for (const [, init] of vi.mocked(client.request).mock.calls) expect(init?.method ?? "GET").toBe("GET");
  });

  it("shows the bare-domain format and corrects URL-shaped input", async () => {
    const interaction = promptWith(["https://example.com", "example.com", "3"]);
    const client: CloudflareClient = {
      request: vi.fn(async (path: string) => {
        if (path.startsWith("/accounts?")) return [{ id: accountId, name: "Example Company" }];
        if (path.startsWith("/zones?")) return [];
        throw new Error(`Unexpected request: ${path}`);
      }),
    } as unknown as CloudflareClient;

    const result = await runPrivateDeploymentPrerequisites(state, {
      client,
      prompt: interaction.prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });

    expect(result.status).toBe("saved");
    expect(result.state.cloudflare?.zone_name).toBe("example.com");
    expect(interaction.output.join("\n")).toContain("Domain to add to Cloudflare (example: example.com; no https://)");
    expect(interaction.output.join("\n")).toContain("Enter only the domain, for example example.com. Do not include https:// or a path.");
  });

  it("persists a domain that becomes active without reporting a false concurrent edit", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-domain-resume-test-"));
    const cliVersion = "0.1.1";
    const created = await createPrivateDeploymentState({
      root,
      cliVersion,
      createId: () => state.deployment_id,
      now: () => new Date("2026-09-01T19:00:00.000Z"),
    });
    const stored = await writePrivateDeploymentState(root, {
      ...created,
      registrar_authority_confirmed: true,
      sign_in_mode: "email-code",
      cloudflare: {
        account_id: accountId,
        account_name: "Example Company",
        zone_name: "example.com",
      },
    }, cliVersion, () => new Date("2026-09-01T19:01:00.000Z"));
    let zoneReads = 0;
    const client = clientFor();
    vi.mocked(client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("/accounts?")) return [{ id: accountId, name: "Example Company" }];
      if (path.startsWith("/zones?")) {
        zoneReads += 1;
        return [{
          id: zoneId,
          name: "example.com",
          status: zoneReads === 1 ? "pending" : "active",
          account: { id: accountId },
          name_servers: ["one.ns.cloudflare.com", "two.ns.cloudflare.com"],
        }];
      }
      if (path.includes("/d1/")) return [];
      if (path.includes("/r2/")) return { buckets: [] };
      if (path.endsWith("/access/organizations")) return { auth_domain: "example.cloudflareaccess.com" };
      if (path.endsWith("/workers/subdomain")) return { subdomain: "example-workers" };
      throw new Error(`Unexpected request: ${path}`);
    });
    let writeClock = Date.parse("2026-09-01T19:02:00.000Z");
    const result = await runPrivateDeploymentPrerequisites(stored, {
      client,
      prompt: promptWith(["2"]).prompt,
      openBrowser: vi.fn(),
      now: () => new Date("2026-09-01T20:00:00.000Z"),
      persist: (nextState) => writePrivateDeploymentState(
        root,
        nextState,
        cliVersion,
        () => new Date(writeClock += 1_000),
      ),
    });

    expect(result.status).toBe("ready");
    expect(result.state.cloudflare).toMatchObject({ zone_id: zoneId, zone_name: "example.com" });
  });

  it("opens only the R2 onboarding page when R2 is the missing commercial prerequisite", async () => {
    const interaction = promptWith(["1", "1", "3"]);
    const openBrowser = vi.fn(async () => undefined);
    const persisted: PrivateDeploymentState[] = [];
    const result = await runPrivateDeploymentPrerequisites(state, {
      client: clientFor({ r2: "pending" }),
      prompt: interaction.prompt,
      openBrowser,
      now: () => now,
      persist: async (nextState) => {
        persisted.push(structuredClone(nextState));
        return nextState;
      },
    });
    expect(result.status).toBe("saved");
    expect(openBrowser).toHaveBeenCalledWith(`https://dash.cloudflare.com/${accountId}/r2/overview`);
    expect(interaction.output.join("\n")).toContain("does not choose or accept");
    expect(persisted).toContainEqual(expect.objectContaining({
      pending_handoff: expect.objectContaining({ kind: "r2" }),
    }));
  });

  it("continues after R2 becomes ready without rejecting its own persisted handoff", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-r2-resume-test-"));
    const cliVersion = "0.1.1";
    const created = await createPrivateDeploymentState({
      root,
      cliVersion,
      createId: () => state.deployment_id,
      now: () => new Date("2026-09-01T19:00:00.000Z"),
    });
    const stored = await writePrivateDeploymentState(root, {
      ...created,
      registrar_authority_confirmed: true,
      sign_in_mode: "email-code",
    }, cliVersion, () => new Date("2026-09-01T19:01:00.000Z"));
    const client = clientFor();
    let r2Reads = 0;
    vi.mocked(client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("/accounts?")) return [{ id: accountId, name: "Example Company" }];
      if (path.startsWith("/zones?")) return [{
        id: zoneId,
        name: "example.com",
        status: "active",
        account: { id: accountId },
        name_servers: ["one.ns.cloudflare.com", "two.ns.cloudflare.com"],
      }];
      if (path.includes("/d1/")) return [];
      if (path.includes("/r2/")) {
        r2Reads += 1;
        if (r2Reads === 1) throw new CloudflareApiError("R2 subscription is not enabled", 403);
        return { buckets: [] };
      }
      if (path.endsWith("/access/organizations")) return { auth_domain: "example.cloudflareaccess.com" };
      if (path.endsWith("/workers/subdomain")) return { subdomain: "example-workers" };
      throw new Error(`Unexpected request: ${path}`);
    });
    let writeClock = Date.parse("2026-09-01T19:02:00.000Z");

    const result = await runPrivateDeploymentPrerequisites(stored, {
      client,
      prompt: promptWith(["1", "2"]).prompt,
      openBrowser: vi.fn(),
      now: () => new Date("2026-09-01T20:00:00.000Z"),
      persist: (nextState) => writePrivateDeploymentState(
        root,
        nextState,
        cliVersion,
        () => new Date(writeClock += 1_000),
      ),
    });

    expect(result.status).toBe("ready");
    expect(result.state.pending_handoff).toBeUndefined();
    expect(result.state.stage).toBe("prerequisites-ready");
  });

  it("persists a pending Zero Trust handoff before opening Cloudflare", async () => {
    const persisted: PrivateDeploymentState[] = [];
    const result = await runPrivateDeploymentPrerequisites(state, {
      client: clientFor({ zeroTrust: "pending" }),
      prompt: promptWith(["1", "1", "3"]).prompt,
      openBrowser: vi.fn(),
      now: () => now,
      persist: async (nextState) => {
        persisted.push(structuredClone(nextState));
        return nextState;
      },
    });

    expect(result.status).toBe("saved");
    expect(persisted).toContainEqual(expect.objectContaining({
      pending_handoff: expect.objectContaining({ kind: "zero-trust" }),
    }));
  });

  it("plans a missing account-wide Workers subdomain without creating it", async () => {
    const client = clientFor({ worker: "absent" });
    const interaction = promptWith(["1", "1"]);
    const result = await runPrivateDeploymentPrerequisites(state, {
      client,
      prompt: interaction.prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });
    expect(result.status).toBe("ready");
    expect(result.state.resources).toMatchObject({
      workers_subdomain: "example-company-artifacts",
      workers_subdomain_action: "create-after-approval",
    });
    expect(interaction.output.join("\n")).toContain("technical fallback");
    expect(interaction.output.join("\n")).toContain("people will use your chosen ArtifactPass domain");
    expect(vi.mocked(client.request).mock.calls.some(([, init]) => init?.method !== undefined && init.method !== "GET")).toBe(false);
  });

  it("stops on a missing capability before any deployment mutation", async () => {
    const client: CloudflareClient = {
      request: vi.fn(async (path: string) => {
        if (path.startsWith("/accounts?")) return [{ id: accountId, name: "Example Company" }];
        if (path.startsWith("/zones?")) return [{ id: zoneId, name: "example.com", status: "active", account: { id: accountId }, name_servers: [] }];
        if (path.includes("/d1/")) throw new CloudflareApiError("forbidden", 403);
        if (path.includes("/r2/")) return { buckets: [] };
        if (path.endsWith("/access/organizations")) return { auth_domain: "example.cloudflareaccess.com" };
        return { subdomain: "example-workers" };
      }),
    } as unknown as CloudflareClient;
    const result = await runPrivateDeploymentPrerequisites(state, {
      client,
      prompt: promptWith(["1"]).prompt,
      openBrowser: vi.fn(),
      now: () => now,
    });
    expect(result).toMatchObject({ status: "permission-denied" });
    expect(result.message).toContain("cannot read D1");
  });
});
