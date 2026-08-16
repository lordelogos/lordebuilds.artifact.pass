import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/artifact-service/vitest.config.ts",
      "packages/*/vitest.config.ts"
    ],
  },
});
