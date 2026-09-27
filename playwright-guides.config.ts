import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "public-guides.spec.ts",
  outputDir: "./test-results/guides",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  webServer: {
    command: "pnpm --dir apps/artifact-pages build && node tests/e2e/support/static-pages-server.mjs",
    url: "http://127.0.0.1:4174/guides",
    reuseExistingServer: false,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
