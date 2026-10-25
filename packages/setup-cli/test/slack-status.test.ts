import { expect, test } from "vitest";

import { createSlackArchiveConfiguration } from "../src/slack/configuration";
import { readSlackArchiveStatus, slackArchiveRecoveryHint } from "../src/slack/status";
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
  const runner: ProcessRunner = async (_command, args) => {
    const sql = args.join(" ");
    return {
      stdout: sql.includes("GROUP BY channel_id")
        ? JSON.stringify([{ results: [{ channel_id: "C1234567890", latest: newest }] }])
        : sql.includes("GROUP BY source_origin")
          ? JSON.stringify([{ results: [{ source_origin: "https://artifactpass.com", latest: newest }] }])
        : sql.includes("GROUP BY status")
          ? JSON.stringify([{ results: [{ status: "succeeded", count: 2, latest: newest }, { status: "failed", count: 1, latest: newest }] }])
          : JSON.stringify([{ results: [{ id: "a".repeat(64), channel_id: "C1234567890", last_error_code: "source_expired" }] }]),
      stderr: "",
    };
  };
  const status = await readSlackArchiveStatus(config, runner);
  expect(status.counts).toEqual({ succeeded: 2, failed: 1, transferring: 0, needs_review: 0 });
  expect(status.verified).toBe(true);
  expect(status.channels).toEqual([{ channel_id: "C1234567890", verified: true }]);
  expect(status.verified_sources).toEqual([{ origin: "https://artifactpass.com", verified: true }]);
  expect(status.failures).toEqual([{ id: "a".repeat(64), channel_id: "C1234567890", last_error_code: "source_expired" }]);
  expect(JSON.stringify(status)).not.toMatch(/share_url|token/iu);
});

test("one successful channel does not mark a multi-channel installation ready", async () => {
  const config = {
    ...createSlackArchiveConfiguration(),
    stage: "manifest-pending" as const,
    account_id: "a".repeat(32), worker_name: "artifactpass-archive-12345678",
    database_id: "12345678-1234-1234-1234-123456789abc",
    enabled_channels: ["C1234567890", "C0987654321"],
  };
  const newest = Date.parse(config.updated_at) + 1;
  const runner: ProcessRunner = async (_command, args) => {
    const sql = args.join(" ");
    return {
      stdout: sql.includes("GROUP BY channel_id")
        ? JSON.stringify([{ results: [{ channel_id: "C1234567890", latest: newest }] }])
        : sql.includes("GROUP BY source_origin")
          ? JSON.stringify([{ results: [{ source_origin: "https://artifactpass.com", latest: newest }] }])
        : sql.includes("GROUP BY status")
          ? JSON.stringify([{ results: [{ status: "succeeded", count: 1, latest: newest }] }])
          : JSON.stringify([{ results: [] }]),
      stderr: "",
    };
  };
  const status = await readSlackArchiveStatus(config, runner);
  expect(status.verified).toBe(false);
  expect(status.channels).toEqual([
    { channel_id: "C1234567890", verified: true },
    { channel_id: "C0987654321", verified: false },
  ]);
});

test("a private source needs its own successful delivery before setup is ready", async () => {
  const config = {
    ...createSlackArchiveConfiguration(),
    stage: "manifest-pending" as const,
    account_id: "a".repeat(32), worker_name: "artifactpass-archive-12345678",
    database_id: "12345678-1234-1234-1234-123456789abc",
    enabled_channels: ["C1234567890"],
    sources: ["https://artifactpass.com", "https://artifacts.example.com"],
  };
  const newest = Date.parse(config.updated_at) + 1;
  const runner: ProcessRunner = async (_command, args) => {
    const sql = args.join(" ");
    return {
      stdout: sql.includes("GROUP BY channel_id")
        ? JSON.stringify([{ results: [{ channel_id: "C1234567890", latest: newest }] }])
        : sql.includes("GROUP BY source_origin")
          ? JSON.stringify([{ results: [{ source_origin: "https://artifactpass.com", latest: newest }] }])
          : sql.includes("GROUP BY status")
            ? JSON.stringify([{ results: [{ status: "succeeded", count: 1, latest: newest }] }])
            : JSON.stringify([{ results: [] }]),
      stderr: "",
    };
  };
  const status = await readSlackArchiveStatus(config, runner);
  expect(status.verified).toBe(false);
  expect(status.verified_sources).toEqual([
    { origin: "https://artifactpass.com", verified: true },
    { origin: "https://artifacts.example.com", verified: false },
  ]);
});

test("old deliveries from a removed source do not break status", async () => {
  const config = {
    ...createSlackArchiveConfiguration(),
    stage: "worker-deployed" as const,
    account_id: "a".repeat(32), worker_name: "artifactpass-archive-12345678",
    database_id: "12345678-1234-1234-1234-123456789abc",
    enabled_channels: ["C1234567890"],
  };
  const newest = Date.parse(config.updated_at) + 1;
  const runner: ProcessRunner = async (_command, args) => {
    const sql = args.join(" ");
    return { stdout: JSON.stringify([{ results: sql.includes("GROUP BY channel_id")
      ? [{ channel_id: "C1234567890", latest: newest }]
      : sql.includes("GROUP BY source_origin")
        ? [{ source_origin: "https://artifactpass.com", latest: newest }, { source_origin: "https://old.example.com", latest: newest }]
        : sql.includes("GROUP BY status") ? [{ status: "succeeded", count: 2, latest: newest }] : [] }]), stderr: "" };
  };
  const status = await readSlackArchiveStatus(config, runner);
  expect(status.verified).toBe(true);
  expect(status.verified_sources).toEqual([{ origin: "https://artifactpass.com", verified: true }]);
});

test("an unprovisioned setup has no invented live verification", async () => {
  const status = await readSlackArchiveStatus(createSlackArchiveConfiguration(), async () => {
    throw new Error("Do not query Cloudflare yet");
  });
  expect(status.verified).toBe(false);
  expect(status.counts).toBeNull();
});

test("failure guidance distinguishes expired sources from uncertain Slack completion", () => {
  expect(slackArchiveRecoveryHint("source_unavailable")).toMatch(/fresh ArtifactPass link/u);
  expect(slackArchiveRecoveryHint("slack_completion_uncertain")).toMatch(/before retrying manually/u);
  expect(slackArchiveRecoveryHint("slack_auth_revoked")).toMatch(/SLACK_BOT_TOKEN/u);
});
