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
  readonly verified: boolean;
}

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
    return { ...base, counts: null, failures: [], verified: false };
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
  const failures = await query("SELECT id, channel_id, last_error_code FROM deliveries WHERE status IN ('failed', 'needs-review') ORDER BY updated_at DESC LIMIT 20");
  const counts = { succeeded: 0, failed: 0, transferring: 0, needs_review: 0 };
  let newestSuccess = 0;
  for (const row of summary) {
    if (typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error("Cloudflare returned invalid archive counts");
    }
    if (row.status === "succeeded") {
      counts.succeeded = row.count;
      newestSuccess = typeof row.latest === "number" ? row.latest : 0;
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
  const verified = config.enabled_channels.length > 0 &&
    config.stage !== "prepared" &&
    newestSuccess >= Date.parse(config.updated_at);
  return { ...base, counts, failures: safeFailures, verified };
};
