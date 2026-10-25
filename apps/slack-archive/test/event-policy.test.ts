import { describe, expect, test } from "vitest";

import { selectArchiveJobs } from "../src/event-receiver";

const url = `https://artifactpass.com/a/${"A".repeat(43)}`;
const config = {
  approvedOrigins: ["https://artifactpass.com"],
  enabledChannelIds: ["C0CC13XRWJG"],
};
const postedEvent = {
  type: "link_shared",
  source: "conversations_history",
  channel: "C0CC13XRWJG",
  message_ts: "1730000000.000100",
  is_bot_user_member: true,
  links: [{ domain: "artifactpass.com", url }],
};

describe("posted Slack link selection", () => {
  test("selects an approved link from a posted message for its own thread", () => {
    expect(selectArchiveJobs(postedEvent, config)).toEqual([{
      channelId: "C0CC13XRWJG",
      messageTs: "1730000000.000100",
      threadTs: "1730000000.000100",
      shareUrl: url,
    }]);
  });

  test("uses the parent thread for a posted reply", () => {
    expect(selectArchiveJobs({ ...postedEvent, thread_ts: "1729999999.000200" }, config)[0]?.threadTs)
      .toBe("1729999999.000200");
  });

  test("accepts a posted Enterprise event without source only with a real channel and timestamp", () => {
    const { source: _, ...withoutSource } = postedEvent;
    expect(selectArchiveJobs(withoutSource, config)).toHaveLength(1);
    expect(selectArchiveJobs({ ...withoutSource, message_ts: "invalid" }, config)).toEqual([]);
  });

  test.each([
    { ...postedEvent, source: "composer" },
    { ...postedEvent, channel: "D0CC13XRWJG" },
    { ...postedEvent, channel: "C0000000000" },
    { ...postedEvent, is_bot_user_member: false },
    { ...postedEvent, links: [{ domain: "artifactpass.com", url: `https://evil.example/a/${"A".repeat(43)}` }] },
  ])("does not select an ineligible link event", (event) => {
    expect(selectArchiveJobs(event, config)).toEqual([]);
  });

  test("deduplicates the same approved link in one message", () => {
    expect(selectArchiveJobs({ ...postedEvent, links: [postedEvent.links[0], postedEvent.links[0]] }, config))
      .toHaveLength(1);
  });
});
