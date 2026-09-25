import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import demoConfigSource from "../wrangler-demo.jsonc?raw";
import pagesConfigSource from "../../artifact-pages/wrangler.jsonc?raw";
import pagesViteConfigSource from "../../artifact-pages/vite.config.ts?raw";
import productionConfigSource from "../wrangler.jsonc?raw";
import serviceViteConfigSource from "../vite.config.ts?raw";
import { pagesFunctionRoutes } from "../src/build/static-public-assets";

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

  it("keeps the application Worker focused on application routes", () => {
    const productionConfig = JSON.parse(productionConfigSource) as {
      assets?: { binding?: string; run_worker_first?: readonly string[] };
      main?: string;
    };
    const demoConfig = JSON.parse(demoConfigSource) as {
      assets?: { binding?: string; run_worker_first?: readonly string[] };
      main?: string;
    };

    expect(productionConfig).toMatchObject({
      main: "src/server/index.ts",
      assets: {
        binding: "ASSETS",
        html_handling: "drop-trailing-slash",
      },
    });
    for (const route of ["/", "/privacy", "/terms", "/robots.txt", "/sitemap.xml"]) {
      expect(productionConfig.assets?.run_worker_first).not.toContain(route);
    }
    expect(demoConfig).toMatchObject({
      main: "src/demo/index.ts",
      assets: {
        binding: "ASSETS",
        run_worker_first: expect.arrayContaining(["/", "/privacy", "/terms"]),
      },
    });
  });

  it("routes only application requests from Pages to the production Worker", () => {
    const pagesConfig = JSON.parse(pagesConfigSource) as {
      name?: string;
      pages_build_output_dir?: string;
      services?: readonly { binding?: string; service?: string }[];
    };

    expect(pagesConfig).toMatchObject({
      name: "artifactpass-site",
      pages_build_output_dir: "./dist",
      services: [{
        binding: "ARTIFACT_APPLICATION",
        service: "lordebuilds-artifacts-share",
      }],
    });
    expect(pagesFunctionRoutes.include).toEqual(expect.arrayContaining([
      "/assets/*",
      "/health",
      "/session/*",
      "/auth/*",
      "/upload",
      "/connect/*",
      "/api/*",
      "/a/*",
    ]));
    for (const route of ["/", "/privacy", "/terms", "/robots.txt", "/sitemap.xml"]) {
      expect(pagesFunctionRoutes.include).not.toContain(route);
    }
  });

  it("builds the public site and deployable application as separate artifacts", () => {
    expect(pagesViteConfigSource).toContain("staticPublicAssets(outputDirectory)");
    expect(pagesViteConfigSource).toContain('"homepage-validation"');
    expect(pagesViteConfigSource).toContain('new URL("./dist"');
    expect(serviceViteConfigSource).not.toContain("staticPublicAssets");
    expect(serviceViteConfigSource).not.toContain("homepage-validation");
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
