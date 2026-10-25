import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";

import worker from "../src/index";

test("a new Worker verifies Slack's callback before app credentials exist but rejects ordinary events", async () => {
  const environment = {
    APPROVED_ORIGINS: JSON.stringify(["https://artifactpass.com"]),
    ENABLED_CHANNEL_IDS: "[]",
    SLACK_TEAM_ID: "",
    SLACK_APP_ID: "",
    ARCHIVE_QUEUE: { send: async () => { throw new Error("Must not queue"); } },
  };
  const challenge = await worker.fetch(new Request("https://bot.example.com/slack/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "url_verification", challenge: "setup-challenge" }),
  }), environment as never);
  expect(challenge.status).toBe(200);
  expect(await challenge.text()).toBe("setup-challenge");
  const event = await worker.fetch(new Request("https://bot.example.com/slack/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "event_callback", event: { type: "link_shared" } }),
  }), environment as never);
  expect(event.status).toBe(401);
  const afterCredentials = await worker.fetch(new Request("https://bot.example.com/slack/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "url_verification", challenge: "setup-challenge" }),
  }), { ...environment, SLACK_SIGNING_SECRET: "test-secret" } as never);
  expect(afterCredentials.status).toBe(401);
});

test("the Worker route accepts a signed posted link and sends one Queue job", async () => {
  const now = Math.floor(Date.now() / 1000);
  const shareUrl = `https://artifactpass.com/a/${"A".repeat(43)}`;
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T1234567890",
    api_app_id: "A1234567890",
    event: {
      type: "link_shared",
      source: "conversations_history",
      channel: "C0CC13XRWJG",
      message_ts: `${now}.000001`,
      is_bot_user_member: true,
      links: [{ domain: "artifactpass.com", url: shareUrl }],
    },
  });
  const signature = createHmac("sha256", "test-secret").update(`v0:${now}:${body}`).digest("hex");
  const jobs: unknown[] = [];
  const response = await worker.fetch(new Request("https://bot.example.com/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": String(now),
      "X-Slack-Signature": `v0=${signature}`,
    },
    body,
  }), {
    SLACK_SIGNING_SECRET: "test-secret",
    SLACK_TEAM_ID: "T1234567890",
    SLACK_APP_ID: "A1234567890",
    APPROVED_ORIGINS: JSON.stringify(["https://artifactpass.com"]),
    ENABLED_CHANNEL_IDS: JSON.stringify(["C0CC13XRWJG"]),
    ARCHIVE_QUEUE: { send: async (job: unknown) => { jobs.push(job); } },
  });
  expect(response.status).toBe(200);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ shareUrl, channelId: "C0CC13XRWJG" });
});

test("the Worker Queue entrypoint posts a file in the originating Slack thread", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001-deliveries.sql", import.meta.url), "utf8"));
  const bytes = new TextEncoder().encode("# Safe notes\n");
  const shareUrl = `https://artifactpass.com/a/${"A".repeat(43)}`;
  let uploaded: Uint8Array | undefined;
  let threadTs: string | null = null;
  vi.stubGlobal("FixedLengthStream", class {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    constructor() {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${shareUrl}/manifest`) return Response.json({
      filename: "safe-notes.md", mime_type: "text/markdown", byte_size: bytes.length,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    if (url === `${shareUrl}/raw`) return new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
    if (url.endsWith("files.getUploadURLExternal")) return Response.json({
      ok: true, upload_url: "https://files.slack.com/upload/test", file_id: "F12345678",
    });
    if (url === "https://files.slack.com/upload/test") {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return new Response("OK");
    }
    if (url.endsWith("files.completeUploadExternal")) {
      threadTs = new URLSearchParams(String(init?.body)).get("thread_ts");
      return Response.json({ ok: true, files: [{ id: "F12345678" }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  let acked = false;
  try {
    await worker.queue({ messages: [{
      body: {
        id: "a".repeat(64), channelId: "C0CC13XRWJG", messageTs: "1730000000.000200",
        threadTs: "1730000000.000100", shareUrl,
      },
      attempts: 1,
      ack: () => { acked = true; },
      retry: () => { throw new Error("Unexpected retry"); },
    }] }, {
      SLACK_SIGNING_SECRET: "unused", SLACK_TEAM_ID: "T1234567890", SLACK_APP_ID: "A1234567890",
      APPROVED_ORIGINS: JSON.stringify(["https://artifactpass.com"]),
      ENABLED_CHANNEL_IDS: JSON.stringify(["C0CC13XRWJG"]),
      ARCHIVE_QUEUE: { send: async () => {} }, SLACK_BOT_TOKEN: "xoxb-test",
      ARCHIVE_DB: {
        prepare: sql => ({ bind: (...values) => ({ run: async () => ({
          meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
        }) }) }),
      },
    });
    expect(acked).toBe(true);
    expect(uploaded).toEqual(bytes);
    expect(threadTs).toBe("1730000000.000100");
    expect(sqlite.prepare("SELECT status, slack_file_id FROM deliveries").get())
      .toMatchObject({ status: "succeeded", slack_file_id: "F12345678" });
  } finally {
    vi.unstubAllGlobals();
    sqlite.close();
  }
});
