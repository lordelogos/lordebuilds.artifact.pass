import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import demoConfigSource from "../wrangler-demo.jsonc?raw";
import productionConfigSource from "../wrangler.jsonc?raw";

describe("deployment runtime", () => {
  it("reports that the local artifact service is healthy", async () => {
    const response = await exports.default.fetch("http://localhost/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      service: "lordebuilds.artifacts.share",
      status: "ok",
    });
  });

  it("binds frontend assets in both production and local demo Workers", () => {
    const productionConfig = JSON.parse(productionConfigSource) as {
      assets?: { binding?: string };
      main?: string;
    };
    const demoConfig = JSON.parse(demoConfigSource) as {
      assets?: { binding?: string };
      main?: string;
    };

    expect(productionConfig).toMatchObject({
      main: "src/server/index.ts",
      assets: { binding: "ASSETS" },
    });
    expect(demoConfig).toMatchObject({
      main: "src/demo/index.ts",
      assets: { binding: "ASSETS" },
    });
  });
});
