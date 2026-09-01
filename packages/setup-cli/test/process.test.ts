import { describe, expect, it } from "vitest";

import { runProcess } from "../src/process";

describe("setup process runner", () => {
  it("terminates a child process that exceeds its deadline", async () => {
    await expect(runProcess(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      timeoutMilliseconds: 25,
    })).rejects.toThrow(/timed out/u);
  });

  it("can launch a child with only the explicitly supplied environment", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({ allowed: process.env.ALLOWED, path: process.env.PATH ?? null }))",
    ], {
      inheritEnvironment: false,
      env: { ALLOWED: "yes" },
    });
    expect(JSON.parse(result.stdout)).toEqual({ allowed: "yes", path: null });
  });
});
