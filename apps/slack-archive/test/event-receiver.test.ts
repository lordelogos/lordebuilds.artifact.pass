import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";

import { handleSlackEvent, type QueuedArchiveJob } from "../src/event-receiver";

const signingSecret = "test-signing-secret";
const now = 1_730_000_000_000;
const shareUrl = `https://artifactpass.com/a/${"A".repeat(43)}`;
const event = {
  type: "event_callback",
  team_id: "T1234567890",
  api_app_id: "A1234567890",
  event_id: "Ev1234567890",
  event: {
    type: "link_shared",
    source: "conversations_history",
    channel: "C0CC13XRWJG",
    message_ts: "1730000000.000100",
    is_bot_user_member: true,
    links: [{ domain: "artifactpass.com", url: shareUrl }],
  },
};

const signedRequest = (body: unknown, timestamp = Math.floor(now / 1000), secret = signingSecret) => {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");
  return new Request("https://bot.example.com/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": String(timestamp),
      "X-Slack-Signature": `v0=${signature}`,
    },
    body: raw,
  });
};

const setup = () => {
  const jobs: QueuedArchiveJob[] = [];
  return {
    jobs,
    options: {
      signingSecret,
      teamId: "T1234567890",
      appId: "A1234567890",
      approvedOrigins: ["https://artifactpass.com"],
      enabledChannelIds: ["C0CC13XRWJG"],
      queue: { send: async (job: QueuedArchiveJob) => { jobs.push(job); } },
      now: () => now,
    },
  };
};

describe("signed Slack event intake", () => {
  test("queues one approved posted link and acknowledges it", async () => {
    const { jobs, options } = setup();
    const response = await handleSlackEvent(signedRequest(event), options);
    expect(response.status).toBe(200);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      channelId: "C0CC13XRWJG",
      messageTs: "1730000000.000100",
      threadTs: "1730000000.000100",
      shareUrl,
    });
    expect(jobs[0]?.id).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("answers a signed Slack URL challenge", async () => {
    const { jobs, options } = setup();
    const response = await handleSlackEvent(signedRequest({ type: "url_verification", challenge: "challenge-value" }), options);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-value");
    expect(jobs).toEqual([]);
  });

  test.each([
    signedRequest(event, Math.floor(now / 1000), "wrong-secret"),
    signedRequest(event, Math.floor(now / 1000) - 301),
  ])("rejects a bad or stale signature before enqueuing", async (request) => {
    const { jobs, options } = setup();
    expect((await handleSlackEvent(request.clone(), options)).status).toBe(401);
    expect(jobs).toEqual([]);
  });

  test.each([
    { ...event, team_id: "TOTHER00000" },
    { ...event, api_app_id: "AOTHER00000" },
  ])("rejects an event for another workspace or app", async (wrongEvent) => {
    const { jobs, options } = setup();
    expect((await handleSlackEvent(signedRequest(wrongEvent), options)).status).toBe(403);
    expect(jobs).toEqual([]);
  });

  test("acknowledges a composer event without fetching or queueing", async () => {
    const { jobs, options } = setup();
    const response = await handleSlackEvent(signedRequest({ ...event, event: { ...event.event, source: "composer" } }), options);
    expect(response.status).toBe(200);
    expect(jobs).toEqual([]);
  });

  test("returns a retryable failure when Queue cannot accept the job", async () => {
    const { options } = setup();
    options.queue.send = async () => { throw new Error("queue unavailable"); };
    const response = await handleSlackEvent(signedRequest(event), options);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(shareUrl);
  });
});
