import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import demoConfigSource from "../wrangler-demo.jsonc?raw";
import productionConfigSource from "../wrangler.jsonc?raw";

vi.mock("@cloudflare/vite-plugin", () => ({
  cloudflare: () => ({ name: "cloudflare" }),
}));
vi.mock("@vitejs/plugin-react", () => ({
  default: () => ({ name: "react" }),
}));
vi.mock("vite", () => ({
  defineConfig: <Config>(config: Config) => config,
}));

describe("deployment runtime", () => {
  it("reports that the local artifact service is healthy", { timeout: 30_000 }, async () => {
    const response = await exports.default.fetch("http://localhost/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      service: "lordebuilds.artifacts.share",
      status: "ok",
      human_auth_mode: "artifactpass",
      authentication_configured: false,
    });
  });

  it("binds frontend assets in both production and local demo Workers", () => {
    const productionConfig = JSON.parse(productionConfigSource) as {
      assets?: { binding?: string; run_worker_first?: readonly string[] };
      main?: string;
    };
    const demoConfig = JSON.parse(demoConfigSource) as {
      assets?: { binding?: string };
      main?: string;
    };

    expect(productionConfig).toMatchObject({
      main: "src/server/index.ts",
      assets: {
        binding: "ASSETS",
        run_worker_first: expect.arrayContaining(["/", "/privacy", "/terms"]),
      },
    });
    expect(demoConfig).toMatchObject({
      main: "src/demo/index.ts",
      assets: { binding: "ASSETS" },
    });
  });

  it("binds the local demo Vite server to the fixed public listener", async () => {
    const { default: demoViteConfig } = await import("../vite-demo.config");
    const resolvedDemoConfig = await Promise.resolve(demoViteConfig);

    expect(resolvedDemoConfig.server).toMatchObject({
      host: "0.0.0.0",
      port: 8787,
      strictPort: true,
    });
  });
});
