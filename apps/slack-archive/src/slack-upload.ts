import type { QueuedArchiveJob } from "./event-receiver";
import { parseApprovedShareUrl } from "./source-policy";

type FailureKind = "terminal" | "retryable" | "needs-review";

export class ArchiveTransferError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly code: string,
  ) {
    super(code);
    this.name = "ArchiveTransferError";
  }
}

interface FixedLengthByteStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface ArchiveTransferOptions {
  readonly approvedOrigins: readonly string[];
  readonly botToken: string;
  readonly now: () => number;
  readonly onCompletionStart: () => Promise<void>;
  readonly fetcher?: typeof fetch;
  readonly createFixedLengthStream?: (length: number) => FixedLengthByteStream;
}

interface SourceMetadata {
  readonly filename: string;
  readonly mimeType: "text/html" | "text/markdown" | "application/pdf";
  readonly byteSize: number;
  readonly expiresAt: number;
}

const maximumBytes = 64 * 1024 * 1024;
const extensions: Record<SourceMetadata["mimeType"], readonly string[]> = {
  "text/html": ["html", "htm"],
  "text/markdown": ["md", "markdown"],
  "application/pdf": ["pdf"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unsafeFilename = (filename: string): boolean =>
  [...filename].some(character => character === "/" || character === "\\" ||
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

const sourceMetadata = (value: unknown, now: number): SourceMetadata => {
  if (!isRecord(value) ||
      typeof value.filename !== "string" || value.filename.length < 1 || value.filename.length > 255 ||
      unsafeFilename(value.filename) ||
      !Number.isSafeInteger(value.byte_size) || typeof value.byte_size !== "number" ||
      typeof value.expires_at !== "string") {
    throw new ArchiveTransferError("terminal", "invalid_source_metadata");
  }
  if (typeof value.mime_type !== "string" || !Object.hasOwn(extensions, value.mime_type)) {
    throw new ArchiveTransferError("terminal", "unsupported_format");
  }
  const mimeType = value.mime_type as SourceMetadata["mimeType"];
  const extension = value.filename.toLowerCase().split(".").pop() ?? "";
  if (!extensions[mimeType].includes(extension)) throw new ArchiveTransferError("terminal", "unsupported_format");
  if (value.byte_size < 1 || value.byte_size > maximumBytes) {
    throw new ArchiveTransferError("terminal", "unsupported_size");
  }
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(expiresAt)) throw new ArchiveTransferError("terminal", "invalid_source_metadata");
  if (expiresAt <= now) throw new ArchiveTransferError("terminal", "source_expired");
  return { filename: value.filename, mimeType, byteSize: value.byte_size, expiresAt };
};

const call = async (fetcher: typeof fetch, url: string, init: RequestInit, code: string): Promise<Response> => {
  try {
    return await fetcher(url, { ...init, redirect: "manual" });
  } catch {
    throw new ArchiveTransferError("retryable", code);
  }
};

const readSlackResult = async (response: Response, code: string): Promise<Record<string, unknown>> => {
  if (response.status === 429 || response.status >= 500) throw new ArchiveTransferError("retryable", "slack_unavailable");
  if (response.status !== 200) throw new ArchiveTransferError("terminal", code);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ArchiveTransferError("retryable", "slack_invalid_response");
  }
  if (!isRecord(data)) throw new ArchiveTransferError("retryable", "slack_invalid_response");
  if (data.ok !== true) {
    if (data.error === "invalid_auth" || data.error === "token_revoked" || data.error === "not_authed") {
      throw new ArchiveTransferError("terminal", "slack_auth_revoked");
    }
    if (data.error === "ratelimited") throw new ArchiveTransferError("retryable", "slack_rate_limited");
    throw new ArchiveTransferError("terminal", code);
  }
  return data;
};

const fixedLengthStream = (length: number): FixedLengthByteStream => {
  const Constructor = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (length: number) => FixedLengthByteStream;
  }).FixedLengthStream;
  if (!Constructor) throw new ArchiveTransferError("terminal", "fixed_length_stream_unavailable");
  return new Constructor(length);
};

export const archiveSource = async (
  job: QueuedArchiveJob,
  options: ArchiveTransferOptions,
): Promise<{ readonly fileId: string }> => {
  const approved = parseApprovedShareUrl(job.shareUrl, options.approvedOrigins);
  if (!approved) throw new ArchiveTransferError("terminal", "source_not_approved");
  const fetcher = options.fetcher ?? fetch;
  const manifest = await call(fetcher, `${approved.shareUrl}/manifest`, { method: "GET" }, "source_unavailable");
  if (manifest.status === 404 || manifest.status === 410) throw new ArchiveTransferError("terminal", "source_unavailable");
  if (manifest.status >= 500) throw new ArchiveTransferError("retryable", "source_unavailable");
  if (manifest.status !== 200) throw new ArchiveTransferError("terminal", "source_access_denied");
  let metadataJson: unknown;
  try {
    metadataJson = await manifest.json();
  } catch {
    throw new ArchiveTransferError("terminal", "invalid_source_metadata");
  }
  const metadata = sourceMetadata(metadataJson, options.now());
  const source = await call(fetcher, `${approved.shareUrl}/raw`, {
    method: "GET",
    headers: { "Accept-Encoding": "identity" },
  }, "source_unavailable");
  if (source.status === 404 || source.status === 410) throw new ArchiveTransferError("terminal", "source_unavailable");
  if (source.status >= 500) throw new ArchiveTransferError("retryable", "source_unavailable");
  if (source.status !== 200 || source.url && new URL(source.url).origin !== approved.origin) {
    throw new ArchiveTransferError("terminal", "source_access_denied");
  }
  if (!source.body || source.headers.get("Content-Length") !== String(metadata.byteSize)) {
    throw new ArchiveTransferError("terminal", "source_length_mismatch");
  }

  const ticketResponse = await call(fetcher, "https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filename: metadata.filename, length: String(metadata.byteSize) }),
  }, "slack_unavailable");
  const ticket = await readSlackResult(ticketResponse, "slack_upload_ticket_failed");
  if (typeof ticket.upload_url !== "string" || typeof ticket.file_id !== "string" || !/^F[A-Z0-9]+$/u.test(ticket.file_id)) {
    throw new ArchiveTransferError("terminal", "slack_invalid_upload_ticket");
  }
  let uploadUrl: URL;
  try {
    uploadUrl = new URL(ticket.upload_url);
  } catch {
    throw new ArchiveTransferError("terminal", "slack_invalid_upload_ticket");
  }
  if (uploadUrl.origin !== "https://files.slack.com" || uploadUrl.username || uploadUrl.password) {
    throw new ArchiveTransferError("terminal", "slack_invalid_upload_ticket");
  }

  const { readable, writable } = (options.createFixedLengthStream ?? fixedLengthStream)(metadata.byteSize);
  const copying = source.body.pipeTo(writable);
  let upload: Response;
  try {
    upload = await fetcher(uploadUrl, {
      method: "POST",
      body: readable,
      headers: { "Content-Type": "application/octet-stream" },
      redirect: "manual",
    });
    await copying;
  } catch {
    void copying.catch(() => undefined);
    throw new ArchiveTransferError("retryable", "slack_byte_upload_failed");
  }
  if (upload.status === 429 || upload.status >= 500) throw new ArchiveTransferError("retryable", "slack_byte_upload_failed");
  if (upload.status !== 200) throw new ArchiveTransferError("terminal", "slack_byte_upload_failed");

  // Persist the uncertain state before calling Slack. A Queue redelivery must not post a second file.
  try {
    await options.onCompletionStart();
  } catch {
    throw new ArchiveTransferError("retryable", "delivery_state_unavailable");
  }
  let completion: Response;
  try {
    completion = await fetcher("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        files: JSON.stringify([{ id: ticket.file_id, title: metadata.filename }]),
        channel_id: job.channelId,
        thread_ts: job.threadTs,
      }),
      redirect: "manual",
    });
    if (completion.status !== 200) throw new Error("Slack completion did not return success");
    const data: unknown = await completion.json();
    if (!isRecord(data) || data.ok !== true || !Array.isArray(data.files) ||
        !data.files.some(file => isRecord(file) && file.id === ticket.file_id)) {
      throw new Error("Slack completion did not confirm the file");
    }
  } catch {
    throw new ArchiveTransferError("needs-review", "slack_completion_uncertain");
  }
  return { fileId: ticket.file_id };
};
