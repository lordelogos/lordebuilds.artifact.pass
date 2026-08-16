import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "local-demo",
    root: new URL("..", import.meta.url).pathname,
    include: ["tests/local-demo.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
