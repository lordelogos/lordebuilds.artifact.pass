import { ArtifactError } from "../storage/artifact-error";
import { sha256 } from "../storage/crypto";

export const consumeRateLimit = async (options: {
  readonly database: D1Database;
  readonly namespace: string;
  readonly source: string;
  readonly timestamp: number;
  readonly windowMilliseconds: number;
  readonly units: number;
  readonly maximumUnits: number;
  readonly errorMessage: string;
}): Promise<void> => {
  if (!Number.isSafeInteger(options.units) || options.units < 0) {
    throw new Error("Rate-limit units must be a non-negative safe integer");
  }
  const bucketKey = await sha256(`${options.namespace}:${options.source}`);
  const row = await options.database.prepare(
    `INSERT INTO request_rate_limits (bucket_key, window_start, request_count, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       window_start = CASE
         WHEN request_rate_limits.expires_at <= excluded.window_start THEN excluded.window_start
         ELSE request_rate_limits.window_start
       END,
       request_count = CASE
         WHEN request_rate_limits.expires_at <= excluded.window_start THEN excluded.request_count
         ELSE request_rate_limits.request_count + excluded.request_count
       END,
       expires_at = CASE
         WHEN request_rate_limits.expires_at <= excluded.window_start THEN excluded.expires_at
         ELSE request_rate_limits.expires_at
       END
     RETURNING request_count`,
  ).bind(
    bucketKey,
    options.timestamp,
    options.units,
    options.timestamp + options.windowMilliseconds,
  ).first<{ readonly request_count: number }>();
  if (row === null || row.request_count > options.maximumUnits) {
    throw new ArtifactError("forbidden", options.errorMessage, 429);
  }
};

export const consumeRequestRateLimit = async (options: {
  readonly database: D1Database;
  readonly namespace: string;
  readonly source: string;
  readonly timestamp: number;
  readonly windowMilliseconds: number;
  readonly maximumRequests: number;
  readonly errorMessage: string;
}): Promise<void> => consumeRateLimit({
  ...options,
  units: 1,
  maximumUnits: options.maximumRequests,
});
