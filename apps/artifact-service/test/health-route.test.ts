import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("reports that the local artifact service is healthy", async () => {
    const response = await exports.default.fetch("http://localhost/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      service: "lordebuilds.artifacts.share",
      status: "ok",
    });
  });
});
