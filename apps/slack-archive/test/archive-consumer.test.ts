import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { consumeArchiveBatch } from "../src/archive-consumer";
import type { DeliveryDatabase } from "../src/delivery-store";
import type { QueuedArchiveJob } from "../src/event-receiver";
import { ArchiveTransferError } from "../src/slack-upload";

const migration = readFileSync(new URL("../migrations/0001-deliveries.sql", import.meta.url), "utf8");
const now = 1_730_000_000_000;
const job: QueuedArchiveJob = {
  id: "a".repeat(64), channelId: "C0CC13XRWJG",
  messageTs: "1730000000.000100", threadTs: "1730000000.000100",
  shareUrl: `https://artifactpass.com/a/${"A".repeat(43)}`,
};

const setup = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const database: DeliveryDatabase = {
    prepare: sql => ({
      bind: (...values) => ({
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
      }),
    }),
  };
  let acknowledged = 0;
  const retried: number[] = [];
  const message = {
    body: job,
    attempts: 1,
    ack: () => { acknowledged++; },
    retry: ({ delaySeconds }: { delaySeconds: number }) => { retried.push(delaySeconds); },
  };
  const options = { database, botToken: "xoxb-test", approvedOrigins: ["https://artifactpass.com"], now: () => now };
  return { sqlite, database, message, options, retried, get acknowledged() { return acknowledged; } };
};

describe("queued archive consumer", () => {
  test("a successful transfer records its Slack file and ignores duplicate delivery", async () => {
    const fixture = setup();
    let transfers = 0;
    const transfer = async (_job: QueuedArchiveJob, options: { onCompletionStart: () => Promise<void> }) => {
      transfers++;
      await options.onCompletionStart();
      return { fileId: "F12345678" };
    };
    await consumeArchiveBatch({ messages: [fixture.message] }, { ...fixture.options, transfer });
    await consumeArchiveBatch({ messages: [fixture.message] }, { ...fixture.options, transfer });
    expect(transfers).toBe(1);
    expect(fixture.acknowledged).toBe(2);
    expect(fixture.sqlite.prepare("SELECT status, slack_file_id FROM deliveries WHERE id = ?").get(job.id))
      .toMatchObject({ status: "succeeded", slack_file_id: "F12345678" });
    fixture.sqlite.close();
  });

  test("a source failure is inspectable and is not retried", async () => {
    const fixture = setup();
    await consumeArchiveBatch({ messages: [fixture.message] }, {
      ...fixture.options,
      transfer: async () => { throw new ArchiveTransferError("terminal", "source_expired"); },
    });
    expect(fixture.acknowledged).toBe(1);
    expect(fixture.retried).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT status, last_error_code FROM deliveries WHERE id = ?").get(job.id))
      .toMatchObject({ status: "failed", last_error_code: "source_expired" });
    fixture.sqlite.close();
  });

  test("a definite transient failure retries after a delay, then stops at the budget", async () => {
    const fixture = setup();
    const transfer = async () => { throw new ArchiveTransferError("retryable", "slack_rate_limited"); };
    await consumeArchiveBatch({ messages: [fixture.message] }, { ...fixture.options, transfer });
    expect(fixture.retried).toEqual([30]);
    expect(fixture.sqlite.prepare("SELECT status, last_error_code FROM deliveries WHERE id = ?").get(job.id))
      .toMatchObject({ status: "transferring", last_error_code: "slack_rate_limited" });
    await consumeArchiveBatch({ messages: [{ ...fixture.message, attempts: 3 }] }, {
      ...fixture.options, now: () => now + 31_000, transfer,
    });
    expect(fixture.sqlite.prepare("SELECT status, last_error_code FROM deliveries WHERE id = ?").get(job.id))
      .toMatchObject({ status: "failed", last_error_code: "retry_budget_exhausted" });
    fixture.sqlite.close();
  });

  test("a completion with unknown Slack outcome remains reviewable on redelivery", async () => {
    const fixture = setup();
    let transfers = 0;
    const transfer = async (_job: QueuedArchiveJob, options: { onCompletionStart: () => Promise<void> }): Promise<{ fileId: string }> => {
      transfers++;
      await options.onCompletionStart();
      throw new ArchiveTransferError("needs-review", "slack_completion_uncertain");
    };
    await consumeArchiveBatch({ messages: [fixture.message] }, { ...fixture.options, transfer });
    await consumeArchiveBatch({ messages: [fixture.message] }, { ...fixture.options, transfer });
    expect(transfers).toBe(1);
    expect(fixture.sqlite.prepare("SELECT status, last_error_code FROM deliveries WHERE id = ?").get(job.id))
      .toMatchObject({ status: "needs-review", last_error_code: "slack_completion_uncertain" });
    fixture.sqlite.close();
  });

  test("an unapproved queued URL is acknowledged without a fetch or stored bearer token", async () => {
    const fixture = setup();
    await consumeArchiveBatch({ messages: [{ ...fixture.message, body: { ...job, shareUrl: `https://evil.example/a/${"A".repeat(43)}` } }] }, {
      ...fixture.options,
      transfer: async () => { throw new Error("must not transfer"); },
    });
    expect(fixture.acknowledged).toBe(1);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM deliveries").get()).toMatchObject({ count: 0 });
    fixture.sqlite.close();
  });
});
