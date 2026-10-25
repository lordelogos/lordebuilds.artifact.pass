import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createSlackArchiveConfiguration, writeSlackArchiveConfiguration } from "../src/slack/configuration";
import { activateSlackArchive } from "../src/slack/activation";
import type { ProcessRunner } from "../src/process";

test("activation refuses to enable signed events until both secrets are in Cloudflare", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-activate-"));
  const statePath = join(directory, "configuration.json");
  const config = {
    ...createSlackArchiveConfiguration(), stage: "worker-deployed" as const,
    account_id: "a".repeat(32), database_id: "12345678-1234-1234-1234-123456789abc",
    queue_name: "artifactpass-archive-12345678-queue", worker_name: "artifactpass-archive-12345678",
    worker_url: "https://artifactpass-archive-12345678.example.workers.dev",
  };
  let deployed = false;
  const runner: ProcessRunner = async (_command, args) => {
    if (args[0] === "secret") return { stdout: JSON.stringify([{ name: "SLACK_BOT_TOKEN" }]), stderr: "" };
    deployed = true;
    throw new Error("Should not deploy");
  };
  try {
    await writeSlackArchiveConfiguration(statePath, config);
    await expect(activateSlackArchive(config, {
      statePath, deploymentRoot: directory, runner,
      teamId: "T1234567890", appId: "A1234567890",
    })).rejects.toThrow(/SLACK_SIGNING_SECRET/);
    expect(deployed).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("activation deploys identity without requiring a second Slack manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-activate-"));
  const statePath = join(directory, "configuration.json");
  const config = {
    ...createSlackArchiveConfiguration(), stage: "worker-deployed" as const,
    account_id: "a".repeat(32), database_id: "12345678-1234-1234-1234-123456789abc",
    queue_name: "artifactpass-archive-12345678-queue", worker_name: "artifactpass-archive-12345678",
    worker_url: "https://artifactpass-archive-12345678.example.workers.dev",
  };
  const runner: ProcessRunner = async (_command, args) => {
    if (args[0] === "secret") return { stdout: JSON.stringify([
      { name: "SLACK_BOT_TOKEN" }, { name: "SLACK_SIGNING_SECRET" },
    ]), stderr: "" };
    if (args[0] === "queues" && args[1] === "info") return { stdout: "OK", stderr: "" };
    if (args[0] === "d1" && args[1] === "list") return { stdout: JSON.stringify([{
      name: "artifactpass-archive-12345678-db", uuid: config.database_id,
    }]), stderr: "" };
    if (args[0] === "deploy") return { stdout: `https://artifactpass-archive-12345678.example.workers.dev`, stderr: "" };
    return { stdout: "OK", stderr: "" };
  };
  try {
    await writeFile(join(directory, "index.js"), "export default {};\n");
    await writeFile(join(directory, "0001-deliveries.sql"), "CREATE TABLE IF NOT EXISTS deliveries (id TEXT);\n");
    await writeSlackArchiveConfiguration(statePath, config);
    const activated = await activateSlackArchive(config, {
      statePath, deploymentRoot: directory, runner,
      teamId: "T1234567890", appId: "A1234567890",
    });
    expect(activated.stage).toBe("worker-deployed");
    expect(activated.enabled_channels).toEqual([]);
    await expect(readFile(join(directory, "app-manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
