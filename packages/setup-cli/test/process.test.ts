import { describe, expect, it } from "vitest";

import { runProcess } from "../src/process";

describe("setup process runner", () => {
  it("terminates a child process that exceeds its deadline", async () => {
    await expect(runProcess(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      timeoutMilliseconds: 25,
    })).rejects.toThrow(/timed out/u);
  });
});
