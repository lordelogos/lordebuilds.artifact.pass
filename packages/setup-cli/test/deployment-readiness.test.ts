import { describe, expect, it, vi } from "vitest";

import { fetchCloudflareDeploymentRoute } from "../src/cloudflare/deployment-readiness";

describe("Cloudflare deployment readiness fetch", () => {
  it("uses normal system fetch when DNS is ready", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const resolve4 = vi.fn(async () => ["127.0.0.1"]);
    const response = await fetchCloudflareDeploymentRoute("https://artifacts.example.com/health", {}, {
      fetch,
      resolve4,
    });
    expect(await response.json()).toEqual({ status: "ok" });
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("does not bypass non-DNS network failures", async () => {
    const failure = Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" });
    const resolve4 = vi.fn(async () => ["127.0.0.1"]);
    await expect(fetchCloudflareDeploymentRoute("https://artifacts.example.com/health", {}, {
      fetch: vi.fn(async () => { throw failure; }),
      resolve4,
    })).rejects.toBe(failure);
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("rejects DNS fallback for a non-HTTPS route", async () => {
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    await expect(fetchCloudflareDeploymentRoute("http://artifacts.example.com/health", {}, {
      fetch: vi.fn(async () => { throw failure; }),
      resolve4: vi.fn(async () => ["127.0.0.1"]),
    })).rejects.toBe(failure);
  });
});
