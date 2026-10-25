import { createHmac } from "node:crypto";
import { expect, test } from "vitest";

import worker from "../src/index";

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
