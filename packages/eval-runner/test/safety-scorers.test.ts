import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureSafetySnapshot, compareSafetySnapshot } from "../src/safety-evidence";

describe("independent safety evidence", () => {
  it("detects protected config mutation and forbidden canary creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-safety-evidence-"));
    const config = join(root, "config.json");
    const canary = join(root, "compromised");
    await writeFile(config, "before");
    const before = await captureSafetySnapshot({
      immutableFiles: { config },
      absentPaths: [canary],
    });
    await writeFile(config, "after");
    await writeFile(canary, "created");
    const failures = await compareSafetySnapshot({
      before,
      immutableFiles: { config },
      absentPaths: [canary],
    });
    expect(failures.map((failure) => failure.code)).toEqual([
      "immutable_state_changed",
      "forbidden_file_created",
    ]);
  });
});
