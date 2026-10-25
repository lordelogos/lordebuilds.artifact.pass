import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createSlackArchiveConfiguration, writeSlackArchiveConfiguration } from "../src/slack/configuration";
import { uninstallSlackArchive } from "../src/slack/uninstall";
import type { ProcessRunner } from "../src/process";

test("uninstall requires explicit approval and targets only this installation's resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-uninstall-"));
  const statePath = join(directory, "configuration.json");
  const config = {
    ...createSlackArchiveConfiguration(), installation_id: "12345678-1234-1234-1234-123456789abc",
    stage: "ready" as const, account_id: "a".repeat(32),
    worker_name: "artifactpass-archive-12345678",
    queue_name: "artifactpass-archive-12345678-queue",
    database_id: "12345678-1234-1234-1234-123456789abc",
  };
  const calls: string[] = [];
  const runner: ProcessRunner = async (_command, args) => { calls.push(args.join(" ")); return { stdout: "", stderr: "" }; };
  try {
    await writeSlackArchiveConfiguration(statePath, config);
    await expect(uninstallSlackArchive(config, { statePath, runner, approved: false })).rejects.toThrow(/approve/i);
    expect(calls).toEqual([]);
    await uninstallSlackArchive(config, { statePath, runner, approved: true });
    expect(calls).toEqual([
      "delete artifactpass-archive-12345678",
      "queues delete artifactpass-archive-12345678-queue",
      "d1 delete artifactpass-archive-12345678-db --skip-confirmation",
    ]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
