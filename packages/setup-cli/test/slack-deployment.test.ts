import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createSlackArchiveConfiguration, readSlackArchiveConfiguration } from "../src/slack/configuration";
import { provisionSlackResources } from "../src/slack/deployment";
import type { ProcessRunner } from "../src/process";

describe("customer-owned Cloudflare resource setup", () => {
  test("an approved setup creates only its own Queue, D1, and Worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-deploy-"));
    const statePath = join(directory, "configuration.json");
    const calls: string[] = [];
    let databaseCreated = false;
    const runner: ProcessRunner = async (command, args) => {
      expect(command).toBe("wrangler");
      calls.push(args.join(" "));
      if (args[0] === "queues" && args[1] === "info") {
        throw new Error('wrangler failed with status 1: Queue "artifactpass-archive-12345678-queue" does not exist. To create it, run: wrangler queues create artifactpass-archive-12345678-queue');
      }
      if (args[0] === "d1" && args[1] === "list") {
        return { stdout: databaseCreated ? JSON.stringify([{ name: "artifactpass-archive-12345678-db", uuid: "12345678-1234-1234-1234-123456789abc" }]) : "[]", stderr: "" };
      }
      if (args[0] === "d1" && args[1] === "create") databaseCreated = true;
      if (args[0] === "deploy") return { stdout: "Deployed https://artifactpass-archive-12345678.example.workers.dev", stderr: "" };
      return { stdout: "OK", stderr: "" };
    };
    try {
      await writeFile(join(directory, "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
      await writeFile(join(directory, "0001-deliveries.sql"), "CREATE TABLE deliveries (id TEXT);\n");
      const config = { ...createSlackArchiveConfiguration(), installation_id: "12345678-1234-1234-1234-123456789abc" };
      const result = await provisionSlackResources(config, {
        accountId: "a".repeat(32), statePath, deploymentRoot: directory,
        runner, approved: true,
      });
      expect(result.stage).toBe("worker-deployed");
      expect(result.worker_url).toBe("https://artifactpass-archive-12345678.example.workers.dev");
      expect(calls).toContain("queues create artifactpass-archive-12345678-queue");
      expect(calls).toContain("d1 create artifactpass-archive-12345678-db");
      expect(calls.some(item => item.startsWith("d1 execute ") && item.includes("--remote"))).toBe(true);
      expect(calls.some(item => item.startsWith("deploy --config "))).toBe(true);
      expect(calls.find(item => item.startsWith("deploy --config "))).not.toContain("--strict");
      const generated = await readFile(join(directory, "wrangler-slack-archive.json"), "utf8");
      expect(generated).toContain("ARCHIVE_QUEUE");
      expect(generated).toContain("ARCHIVE_DB");
      expect(generated).not.toMatch(/token|secret|share_url/iu);
      expect(await readSlackArchiveConfiguration(statePath)).toEqual(result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("without explicit approval it makes no external calls", async () => {
    let called = false;
    await expect(provisionSlackResources(createSlackArchiveConfiguration(), {
      accountId: "a".repeat(32), statePath: "/tmp/unused-state.json", deploymentRoot: "/tmp",
      runner: async () => { called = true; return { stdout: "", stderr: "" }; },
      approved: false,
    })).rejects.toThrow(/approve/i);
    expect(called).toBe(false);
  });
});
