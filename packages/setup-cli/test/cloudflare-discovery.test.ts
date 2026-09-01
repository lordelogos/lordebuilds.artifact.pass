import { describe, expect, it, vi } from "vitest";

import { CloudflareApiError, type CloudflareClient } from "../src/cloudflare/client";
import {
  cloudflareDashboardUrls,
  inspectCloudflarePrerequisites,
  listCloudflareAccounts,
  listCloudflareZones,
  suggestWorkersSubdomain,
} from "../src/cloudflare/discovery";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);

const clientWith = (request: (path: string) => Promise<unknown>): CloudflareClient => ({
  request: vi.fn(request),
}) as unknown as CloudflareClient;

describe("Cloudflare private deployment discovery", () => {
  it("lists stable account and zone choices without accepting foreign zones", async () => {
    const client = clientWith(async (path) => {
      if (path.startsWith("/accounts")) return [
        { id: "c".repeat(32), name: "Zulu" },
        { id: accountId, name: "Alpha" },
      ];
      return [
        { id: zoneId, name: "example.com", status: "pending", account: { id: accountId }, name_servers: ["one.ns.cloudflare.com"] },
        { id: "d".repeat(32), name: "foreign.test", status: "active", account: { id: "e".repeat(32) }, name_servers: [] },
      ];
    });
    expect((await listCloudflareAccounts(client)).map(({ name }) => name)).toEqual(["Alpha", "Zulu"]);
    expect(await listCloudflareZones(client, accountId)).toEqual([{
      id: zoneId,
      account_id: accountId,
      name: "example.com",
      status: "pending",
      name_servers: ["one.ns.cloudflare.com"],
    }]);
  });

  it("detects already active prerequisites without mutating Cloudflare", async () => {
    const client = clientWith(async (path) => {
      if (path.includes("/r2/")) return { buckets: [] };
      if (path.endsWith("/access/organizations")) return { auth_domain: "team.cloudflareaccess.com" };
      if (path.endsWith("/workers/subdomain")) return { subdomain: "company-workers" };
      return [];
    });
    await expect(inspectCloudflarePrerequisites(client, accountId)).resolves.toEqual({
      d1: { status: "ready", evidence: { accessible: true } },
      r2: { status: "ready", evidence: { accessible: true } },
      zeroTrust: { status: "ready", evidence: { auth_domain: "team.cloudflareaccess.com" } },
      workersSubdomain: { status: "ready", evidence: { subdomain: "company-workers" } },
    });
    for (const [, init] of vi.mocked(client.request).mock.calls) expect(init?.method ?? "GET").toBe("GET");
  });

  it("distinguishes first-time onboarding from missing permission", async () => {
    const client = clientWith(async (path) => {
      if (path.includes("/r2/")) throw new CloudflareApiError("R2 subscription is not enabled", 403);
      if (path.endsWith("/access/organizations")) throw new CloudflareApiError("not found", 404);
      if (path.endsWith("/workers/subdomain")) throw new CloudflareApiError("forbidden", 403);
      throw new CloudflareApiError("forbidden", 403);
    });
    const result = await inspectCloudflarePrerequisites(client, accountId);
    expect(result.r2.status).toBe("pending");
    expect(result.zeroTrust.status).toBe("pending");
    expect(result.d1.status).toBe("permission-denied");
    expect(result.workersSubdomain.status).toBe("permission-denied");
  });

  it("turns rate limits into an actionable retry state", async () => {
    const client = clientWith(async () => { throw new CloudflareApiError("rate limited", 429); });
    const result = await inspectCloudflarePrerequisites(client, accountId);
    expect(result.d1).toMatchObject({ status: "pending", message: expect.stringContaining("retry later (429)") });
    expect(result.r2.status).toBe("pending");
  });

  it("derives safe suggestions and dashboard-only commercial handoffs", () => {
    expect(suggestWorkersSubdomain("Lorde Builds, Inc.")).toBe("lorde-builds-inc-artifacts");
    expect(cloudflareDashboardUrls(accountId)).toEqual({
      addDomain: `https://dash.cloudflare.com/${accountId}/domains/new`,
      r2: `https://dash.cloudflare.com/${accountId}/r2/overview`,
      zeroTrust: `https://one.dash.cloudflare.com/${accountId}/home`,
    });
  });
});
