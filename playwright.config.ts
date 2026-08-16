import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.ARTIFACT_SHARE_E2E_BASE_URL ?? "https://artifact-share.invalid";
const storageState = process.env.ARTIFACT_SHARE_E2E_STORAGE_STATE;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  retries: process.env.CI === undefined ? 0 : 2,
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: "pnpm --dir apps/artifact-service preview:test",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: process.env.CI === undefined,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    ...(storageState === undefined ? {} : { storageState }),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
