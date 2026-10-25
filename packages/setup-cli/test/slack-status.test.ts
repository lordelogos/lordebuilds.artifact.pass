import { expect, test } from "vitest";

import { createSlackArchiveConfiguration } from "../src/slack/configuration";
import { readSlackArchiveStatus } from "../src/slack/status";
import type { ProcessRunner } from "../src/process";

test("status reports verified delivery counts and token-free failures", async () => {
  const config = {
    ...createSlackArchiveConfiguration(),
    stage: "manifest-pending" as const,
    account_id: "a".repeat(32), worker_name: "artifactpass-archive-12345678",
    database_id: "12345678-1234-1234-1234-123456789abc",
    enabled_channels: ["C1234567890"],
  };
  const newest = Date.parse(config.updated_at) + 1;
  const runner: ProcessRunner = async (_command, args) => ({
    stdout: args.join(" ").includes("GROUP BY")
      ? JSON.stringify([{ results: [{ status: "succeeded", count: 2, latest: newest }, { status: "failed", count: 1, latest: newest }] }])
      : JSON.stringify([{ results: [{ id: "a".repeat(64), channel_id: "C1234567890", last_error_code: "source_expired" }] }]),
    stderr: "",
  });
  const status = await readSlackArchiveStatus(config, runner);
  expect(status.counts).toEqual({ succeeded: 2, failed: 1, transferring: 0, needs_review: 0 });
  expect(status.verified).toBe(true);
  expect(status.failures).toEqual([{ id: "a".repeat(64), channel_id: "C1234567890", last_error_code: "source_expired" }]);
  expect(JSON.stringify(status)).not.toMatch(/share_url|token/iu);
});

test("an unprovisioned setup has no invented live verification", async () => {
  const status = await readSlackArchiveStatus(createSlackArchiveConfiguration(), async () => {
    throw new Error("Do not query Cloudflare yet");
  });
  expect(status.verified).toBe(false);
  expect(status.counts).toBeNull();
});
