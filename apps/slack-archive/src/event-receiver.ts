import { parseApprovedShareUrl } from "./source-policy";

export interface ArchiveJob {
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs: string;
  readonly shareUrl: string;
  readonly unfurlId?: string;
}

export interface ArchiveSelectionConfig {
  readonly approvedOrigins: readonly string[];
  readonly enabledChannelIds: readonly string[];
}

export interface QueuedArchiveJob extends ArchiveJob {
  readonly id: string;
}

export interface SlackEventOptions extends ArchiveSelectionConfig {
  readonly signingSecret: string;
  readonly teamId: string;
  readonly appId: string;
  readonly queue: {
    send(job: QueuedArchiveJob): Promise<void>;
    sendBatch?(messages: readonly { body: QueuedArchiveJob }[]): Promise<void>;
  };
  readonly now: () => number;
}

const channelId = /^[CG][A-Z0-9]{8,}$/u;
const messageTimestamp = /^\d{9,}\.\d{1,6}$/u;
const unfurlId = /^[A-Za-z0-9._-]{1,256}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const selectArchiveJobs = (event: unknown, config: ArchiveSelectionConfig): ArchiveJob[] => {
  if (!isRecord(event) || event.type !== "link_shared") return [];
  if (event.source !== undefined && event.source !== "conversations_history") return [];
  if (event.is_bot_user_member !== true) return [];
  if (typeof event.channel !== "string" || !channelId.test(event.channel)) return [];
  if (!config.enabledChannelIds.includes(event.channel)) return [];
  if (typeof event.message_ts !== "string" || !messageTimestamp.test(event.message_ts)) return [];
  if (event.thread_ts !== undefined &&
      (typeof event.thread_ts !== "string" || !messageTimestamp.test(event.thread_ts))) return [];
  if (!Array.isArray(event.links)) return [];

  const jobs: ArchiveJob[] = [];
  const seen = new Set<string>();
  for (const link of event.links) {
    if (!isRecord(link)) continue;
    const share = parseApprovedShareUrl(link.url, config.approvedOrigins);
    if (!share || seen.has(share.shareUrl)) continue;
    seen.add(share.shareUrl);
    jobs.push({
      channelId: event.channel,
      messageTs: event.message_ts,
      threadTs: event.thread_ts ?? event.message_ts,
      shareUrl: share.shareUrl,
      ...(typeof event.unfurl_id === "string" && unfurlId.test(event.unfurl_id)
        ? { unfurlId: event.unfurl_id } : {}),
    });
  }
  return jobs;
};

const text = new TextEncoder();
const noStore = { "Cache-Control": "no-store" };
const maximumBodyBytes = 65_536;

const readBody = async (request: Request): Promise<string | null> => {
  const announcedSize = Number(request.headers.get("Content-Length"));
  if (announcedSize > maximumBodyBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximumBodyBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const verifySignature = async (request: Request, rawBody: string, secret: string, now: number): Promise<boolean> => {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");
  if (!timestamp || !/^\d{10,}$/u.test(timestamp) || !signature || !/^v0=[a-f0-9]{64}$/u.test(signature)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(signature.slice(3).match(/.{2}/gu)!.map(byte => Number.parseInt(byte, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, text.encode(`v0:${timestamp}:${rawBody}`));
};

const archiveId = async (teamId: string, job: ArchiveJob): Promise<string> => {
  const input = text.encode(JSON.stringify([teamId, job.channelId, job.messageTs, job.shareUrl]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

// A newly created Slack app has no signing secret available to the customer yet.
// This endpoint answers only Slack's one-time URL challenge until credentials are installed.
// It never accepts or queues an event in this state.
export const handleSlackBootstrapChallenge = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: noStore });
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    return new Response("Expected JSON", { status: 415, headers: noStore });
  }
  const rawBody = await readBody(request);
  if (rawBody === null) return new Response("Request too large", { status: 413, headers: noStore });
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400, headers: noStore }); }
  if (!isRecord(payload) || payload.type !== "url_verification" ||
      typeof payload.challenge !== "string" || payload.challenge.length < 1 || payload.challenge.length > 256) {
    return new Response("Unauthorized", { status: 401, headers: noStore });
  }
  return new Response(payload.challenge, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
};

export const handleSlackEvent = async (request: Request, options: SlackEventOptions): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: noStore });
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    return new Response("Expected JSON", { status: 415, headers: noStore });
  }
  const rawBody = await readBody(request);
  if (rawBody === null) return new Response("Request too large", { status: 413, headers: noStore });
  if (!await verifySignature(request, rawBody, options.signingSecret, options.now())) {
    return new Response("Unauthorized", { status: 401, headers: noStore });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: noStore });
  }
  if (!isRecord(payload)) return new Response("Invalid event", { status: 400, headers: noStore });
  if (payload.type === "url_verification") {
    if (typeof payload.challenge !== "string" || payload.challenge.length > 256) {
      return new Response("Invalid challenge", { status: 400, headers: noStore });
    }
    return new Response(payload.challenge, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (payload.type !== "event_callback") return new Response("OK", { headers: noStore });
  if (payload.team_id !== options.teamId || payload.api_app_id !== options.appId) {
    return new Response("Wrong workspace or app", { status: 403, headers: noStore });
  }
  const jobs = selectArchiveJobs(payload.event, options);
  try {
    const queued = await Promise.all(jobs.map(async job => ({ ...job, id: await archiveId(options.teamId, job) })));
    if (options.queue.sendBatch) {
      for (let index = 0; index < queued.length; index += 100) {
        await options.queue.sendBatch(queued.slice(index, index + 100).map(body => ({ body })));
      }
    } else {
      for (const job of queued) await options.queue.send(job);
    }
  } catch {
    return new Response("Archive queue unavailable", { status: 503, headers: noStore });
  }
  return new Response("OK", { headers: noStore });
};

