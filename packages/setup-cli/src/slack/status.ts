import { runProcess, type ProcessRunner } from "../process";
import type { SlackArchiveConfiguration } from "./configuration";

export interface SlackArchiveFailure {
  readonly id: string;
  readonly channel_id: string;
  readonly last_error_code: string | null;
}

export interface SlackArchiveStatus {
  readonly stage: SlackArchiveConfiguration["stage"];
  readonly paused: boolean;
  readonly sources: readonly string[];
  readonly enabled_channels: readonly string[];
  readonly worker_url?: string;
  readonly counts: {
    readonly succeeded: number;
    readonly failed: number;
    readonly transferring: number;
    readonly needs_review: number;
  } | null;
  readonly failures: readonly SlackArchiveFailure[];
  readonly channels: readonly { readonly channel_id: string; readonly verified: boolean }[];
  readonly verified_sources: readonly { readonly origin: string; readonly verified: boolean }[];
  readonly verified: boolean;
}

export const slackArchiveRecoveryHint = (code: string | null): string => {
  switch (code) {
    case "source_expired":
    case "source_unavailable":
      return "The link has expired or is unavailable. Post a fresh ArtifactPass link; the old one cannot be recovered.";
    case "source_access_denied":
      return "Check that the private source permits share-link reads and that its origin is approved in both the Worker and Slack app manifest.";
    case "source_not_approved":
      return "Approve the source origin and apply the updated Slack app manifest before posting a new link.";
    case "slack_auth_revoked":
      return "Check the Slack app installation and rotate SLACK_BOT_TOKEN in the archive Worker, then post a new link.";
    case "slack_completion_uncertain":
      return "Inspect this Slack thread and its files before retrying manually. The bot will not risk a duplicate upload.";
    case "retry_budget_exhausted":
    case "slack_unavailable":
    case "slack_rate_limited":
      return "Check Slack and Queue health, then post a fresh live link after the service recovers.";
    default:
      return "Inspect the source link, Slack app membership, and archive Worker logs before posting a fresh link.";
  }
};

const rowsFrom = (source: string): Record<string, unknown>[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Cloudflare returned unreadable D1 results");
  }
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object" ||
      !("results" in parsed[0]) || !Array.isArray(parsed[0].results) ||
      !parsed[0].results.every((item: unknown) => typeof item === "object" && item !== null)) {
    throw new Error("Cloudflare returned unexpected D1 results");
  }
  return parsed[0].results as Record<string, unknown>[];
};

export const readSlackArchiveStatus = async (
  config: SlackArchiveConfiguration,
  runner: ProcessRunner = runProcess,
): Promise<SlackArchiveStatus> => {
  const base = {
    stage: config.stage,
    paused: config.paused,
    sources: config.sources,
    enabled_channels: config.enabled_channels,
    ...(config.worker_url ? { worker_url: config.worker_url } : {}),
  };
  if (!config.account_id || !config.database_id || !config.worker_name) {
    return { ...base, counts: null, failures: [],
      channels: config.enabled_channels.map(channel_id => ({ channel_id, verified: false })),
      verified_sources: config.sources.map(origin => ({ origin, verified: false })), verified: false };
  }
  const databaseName = `${config.worker_name}-db`;
  const environment = { CLOUDFLARE_ACCOUNT_ID: config.account_id };
  const query = async (sql: string) => {
    const result = await runner("wrangler", ["d1", "execute", databaseName, "--remote", "--json", "--yes", "--command", sql], {
      env: environment,
    });
    return rowsFrom(result.stdout);
  };
  const summary = await query("SELECT status, COUNT(*) AS count, MAX(updated_at) AS latest FROM deliveries GROUP BY status");
  const channelRows = await query("SELECT channel_id, MAX(updated_at) AS latest FROM deliveries WHERE status = 'succeeded' GROUP BY channel_id");
  const sourceRows = await query("SELECT source_origin, MAX(updated_at) AS latest FROM deliveries WHERE status = 'succeeded' GROUP BY source_origin");
  const failures = await query("SELECT id, channel_id, last_error_code FROM deliveries WHERE status IN ('failed', 'needs-review') ORDER BY updated_at DESC LIMIT 20");
  const counts = { succeeded: 0, failed: 0, transferring: 0, needs_review: 0 };
  for (const row of summary) {
    if (typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error("Cloudflare returned invalid archive counts");
    }
    if (row.status === "succeeded") {
      counts.succeeded = row.count;
    } else if (row.status === "failed") counts.failed = row.count;
    else if (row.status === "transferring") counts.transferring = row.count;
    else if (row.status === "needs-review") counts.needs_review = row.count;
  }
  const safeFailures = failures.map(row => {
    if (typeof row.id !== "string" || !/^[a-f0-9]{64}$/u.test(row.id) ||
        typeof row.channel_id !== "string" || !/^[CG][A-Z0-9]{8,}$/u.test(row.channel_id) ||
        row.last_error_code !== null && typeof row.last_error_code !== "string") {
      throw new Error("Cloudflare returned invalid archive failure records");
    }
    return {
      id: row.id,
      channel_id: row.channel_id,
      last_error_code: row.last_error_code,
    };
  });
  const successes = new Map<string, number>();
  for (const row of channelRows) {
    if (typeof row.channel_id !== "string" || !/^[CG][A-Z0-9]{8,}$/u.test(row.channel_id) ||
        typeof row.latest !== "number" || !Number.isSafeInteger(row.latest)) {
      throw new Error("Cloudflare returned invalid channel delivery results");
    }
    successes.set(row.channel_id, row.latest);
  }
  const channels = config.enabled_channels.map(channel_id => ({
    channel_id,
    verified: (successes.get(channel_id) ?? 0) >= Date.parse(config.updated_at),
  }));
  const sourceSuccesses = new Map<string, number>();
  for (const row of sourceRows) {
    if (typeof row.source_origin !== "string" ||
        typeof row.latest !== "number" || !Number.isSafeInteger(row.latest)) {
      throw new Error("Cloudflare returned invalid source delivery results");
    }
    if (config.sources.includes(row.source_origin)) sourceSuccesses.set(row.source_origin, row.latest);
  }
  const verified_sources = config.sources.map(origin => ({
    origin,
    verified: (sourceSuccesses.get(origin) ?? 0) >= Date.parse(config.updated_at),
  }));
  const verified = channels.length > 0 && config.stage !== "prepared" &&
    channels.every(channel => channel.verified) && verified_sources.every(source => source.verified);
  return { ...base, counts, failures: safeFailures, channels, verified_sources, verified };
};
