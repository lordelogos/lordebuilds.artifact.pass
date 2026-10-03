import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "setup-cli",
    include: ["test/**/*.test.ts"],
    // Cloudflare registers one fixed loopback OAuth callback. Keep setup CLI
    // test files serial so independent authorization suites cannot contend for
    // that production callback port on shared CI runners.
    fileParallelism: false,
  },
});
