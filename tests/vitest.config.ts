import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "release",
    root: new URL(".", import.meta.url).pathname,
    include: ["release/**/*.test.ts", "agent-portability.test.ts"],
  },
});
