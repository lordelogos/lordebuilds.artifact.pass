import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "setup-cli",
    include: ["test/**/*.test.ts"],
  },
});
