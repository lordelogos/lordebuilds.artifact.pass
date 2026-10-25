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
  let workerIsQueueConsumer = true;
  const runner: ProcessRunner = async (_command, args) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "queues consumer worker remove artifactpass-archive-12345678-queue artifactpass-archive-12345678") {
      workerIsQueueConsumer = false;
    }
    if (args[0] === "delete" && workerIsQueueConsumer) {
      throw new Error("Cannot delete this Worker as it is a consumer for a Queue. [code: 10064]");
    }
    return { stdout: "", stderr: "" };
  };
  try {
    await writeSlackArchiveConfiguration(statePath, config);
    await expect(uninstallSlackArchive(config, { statePath, runner, approved: false })).rejects.toThrow(/approve/i);
    expect(calls).toEqual([]);
    await uninstallSlackArchive(config, { statePath, runner, approved: true });
    expect(calls).toEqual([
      "queues consumer worker remove artifactpass-archive-12345678-queue artifactpass-archive-12345678",
      "delete artifactpass-archive-12345678",
      "queues delete artifactpass-archive-12345678-queue",
      "d1 delete artifactpass-archive-12345678-db --skip-confirmation",
    ]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed Cloudflare deletion keeps setup state and does not show raw Wrangler output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-uninstall-"));
  const statePath = join(directory, "configuration.json");
  const config = {
    ...createSlackArchiveConfiguration(), installation_id: "12345678-1234-1234-1234-123456789abc",
    stage: "ready" as const, account_id: "a".repeat(32),
    worker_name: "artifactpass-archive-12345678",
    queue_name: "artifactpass-archive-12345678-queue",
  };
  let detached = false;
  let workerDeletionAttempts = 0;
  const runner: ProcessRunner = async (_command, args) => {
    if (args[0] === "queues" && args[1] === "consumer") {
      if (detached) throw new Error("Consumer not found");
      detached = true;
    }
    if (args[0] === "delete" && ++workerDeletionAttempts === 1) {
      throw new Error("wrangler failed with status 1: raw API response [code: 10064]");
    }
    return { stdout: "", stderr: "" };
  };
  try {
    await writeSlackArchiveConfiguration(statePath, config);
    await expect(uninstallSlackArchive(config, { statePath, runner, approved: true }))
      .rejects.toThrow("Could not delete the archive Worker. Your saved setup was kept; check your Cloudflare connection and try again.");
    expect(await readFile(statePath, "utf8")).toContain("artifactpass-archive-12345678");
    await uninstallSlackArchive(config, { statePath, runner, approved: true });
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
