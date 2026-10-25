import { describe, expect, test } from "vitest";

import type { QueuedArchiveJob } from "../src/event-receiver";
import { archiveSource, ArchiveTransferError } from "../src/slack-upload";

const token = "A".repeat(43);
const now = Date.parse("2026-10-24T12:00:00Z");

const jobFor = (origin: string): QueuedArchiveJob => ({
  id: "a".repeat(64),
  channelId: "C0CC13XRWJG",
  messageTs: "1730000000.000200",
  threadTs: "1730000000.000100",
  shareUrl: `${origin}/a/${token}`,
});

const fixedStream = () => new TransformStream<Uint8Array, Uint8Array>();

const fixture = (origin: string, filename: string, mimeType: string, content: Uint8Array) => {
  let completed = false;
  let completionStarted = false;
  let uploaded: Uint8Array | undefined;
  let completion: URLSearchParams | undefined;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${origin}/a/${token}/manifest`) {
      return Response.json({
        filename,
        mime_type: mimeType,
        byte_size: content.byteLength,
        expires_at: new Date(now + 60_000).toISOString(),
      });
    }
    if (url === `${origin}/a/${token}/raw`) {
      return new Response(content, { headers: { "Content-Length": String(content.byteLength) } });
    }
    if (url === "https://slack.com/api/files.getUploadURLExternal") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("filename")).toBe(filename);
      expect(body.get("length")).toBe(String(content.byteLength));
      return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/test", file_id: "F12345678" });
    }
    if (url === "https://files.slack.com/upload/test") {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return new Response("OK");
    }
    if (url === "https://slack.com/api/files.completeUploadExternal") {
      expect(completionStarted).toBe(true);
      completion = new URLSearchParams(String(init?.body));
      completed = true;
      return Response.json({ ok: true, files: [{ id: "F12345678" }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return {
    fetcher,
    get uploaded() { return uploaded; },
    get completion() { return completion; },
    get completed() { return completed; },
    onCompletionStart: async () => { completionStarted = true; },
  };
};

describe("ArtifactPass to Slack transfer", () => {
  test.each([
    ["https://artifactpass.com", "report.html", "text/html", new TextEncoder().encode("<h1>Safe example</h1>")],
    ["https://artifacts.example.com", "notes.md", "text/markdown", new TextEncoder().encode("# Notes\n")],
    ["https://artifactpass.com", "proposal.pdf", "application/pdf", new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])],
  ])("uploads exact %s bytes and completes in the parent thread", async (origin, filename, mimeType, bytes) => {
    const network = fixture(origin, filename, mimeType, bytes);
    const result = await archiveSource(jobFor(origin), {
      approvedOrigins: [origin], botToken: "xoxb-test", now: () => now,
      fetcher: network.fetcher, createFixedLengthStream: fixedStream,
      onCompletionStart: network.onCompletionStart,
    });
    expect(result).toEqual({ fileId: "F12345678" });
    expect(network.uploaded).toEqual(bytes);
    expect(network.completion?.get("channel_id")).toBe("C0CC13XRWJG");
    expect(network.completion?.get("thread_ts")).toBe("1730000000.000100");
    expect(network.completed).toBe(true);
  });

  test("expired metadata fails before asking Slack for an upload URL", async () => {
    const origin = "https://artifactpass.com";
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Response.json({ filename: "old.md", mime_type: "text/markdown", byte_size: 5, expires_at: new Date(now - 1).toISOString() });
    };
    await expect(archiveSource(jobFor(origin), {
      approvedOrigins: [origin], botToken: "xoxb-test", now: () => now,
      fetcher, createFixedLengthStream: fixedStream, onCompletionStart: async () => {},
    })).rejects.toMatchObject({ kind: "terminal", code: "source_expired" } satisfies Partial<ArchiveTransferError>);
    expect(calls).toBe(1);
  });

  test.each([
    ["oversized", { filename: "large.pdf", mime_type: "application/pdf", byte_size: 67_108_865, expires_at: new Date(now + 60_000).toISOString() }, "unsupported_size"],
    ["wrong format", { filename: "script.js", mime_type: "application/javascript", byte_size: 5, expires_at: new Date(now + 60_000).toISOString() }, "unsupported_format"],
  ])("%s metadata is terminal", async (_name, manifest, code) => {
    const origin = "https://artifactpass.com";
    await expect(archiveSource(jobFor(origin), {
      approvedOrigins: [origin], botToken: "xoxb-test", now: () => now,
      fetcher: async () => Response.json(manifest), createFixedLengthStream: fixedStream,
      onCompletionStart: async () => {},
    })).rejects.toMatchObject({ kind: "terminal", code });
  });

  test("missing raw length fails before Slack upload", async () => {
    const origin = "https://artifactpass.com";
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls === 1) return Response.json({ filename: "notes.md", mime_type: "text/markdown", byte_size: 5, expires_at: new Date(now + 60_000).toISOString() });
      return new Response("notes");
    };
    await expect(archiveSource(jobFor(origin), {
      approvedOrigins: [origin], botToken: "xoxb-test", now: () => now,
      fetcher, createFixedLengthStream: fixedStream, onCompletionStart: async () => {},
    })).rejects.toMatchObject({ kind: "terminal", code: "source_length_mismatch" });
    expect(calls).toBe(2);
  });

  test("revoked Slack token is a definite failure before byte upload", async () => {
    const origin = "https://artifactpass.com";
    let calls = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      calls++;
      if (String(input).endsWith("/manifest")) return Response.json({ filename: "notes.md", mime_type: "text/markdown", byte_size: 5, expires_at: new Date(now + 60_000).toISOString() });
      if (String(input).endsWith("/raw")) return new Response("notes", { headers: { "Content-Length": "5" } });
      return Response.json({ ok: false, error: "invalid_auth" });
    };
    await expect(archiveSource(jobFor(origin), {
      approvedOrigins: [origin], botToken: "xoxb-test", now: () => now,
      fetcher, createFixedLengthStream: fixedStream, onCompletionStart: async () => {},
    })).rejects.toMatchObject({ kind: "terminal", code: "slack_auth_revoked" });
    expect(calls).toBe(3);
  });

  test("an uncertain completion is marked reviewable, not retryable", async () => {
    const origin = "https://artifactpass.com";
    const bytes = new TextEncoder().encode("# Notes\n");
    const network = fixture(origin, "notes.md", "text/markdown", bytes);
    await expect(archiveSource(jobFor(origin), {
      approvedOrigins: [origin], botToken: "xoxb-test", now: () => now,
      fetcher: async (input, init) => String(input).endsWith("completeUploadExternal")
        ? Promise.reject(new Error("connection lost")) : network.fetcher(input, init),
      createFixedLengthStream: fixedStream, onCompletionStart: network.onCompletionStart,
    })).rejects.toMatchObject({ kind: "needs-review", code: "slack_completion_uncertain" });
    expect(network.uploaded).toEqual(bytes);
  });
});
