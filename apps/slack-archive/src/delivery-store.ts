import type { QueuedArchiveJob } from "./event-receiver";

export interface DeliveryDatabase {
  prepare(sql: string): {
    bind(...values: (string | number | null)[]): {
      run(): Promise<{ meta: { changes: number } }>;
      first(): Promise<Record<string, unknown> | null>;
    };
  };
}

const leaseMilliseconds = 10 * 60 * 1_000;

export const activeLeaseUntil = async (database: DeliveryDatabase, id: string): Promise<number | null> => {
  const row = await database.prepare("SELECT status, lease_until FROM deliveries WHERE id = ?").bind(id).first();
  return row?.status === "transferring" && typeof row.lease_until === "number" && Number.isSafeInteger(row.lease_until)
    ? row.lease_until : null;
};

export const claimDelivery = async (database: DeliveryDatabase, job: QueuedArchiveJob, now: number): Promise<string | null> => {
  const claimId = crypto.randomUUID();
  const origin = new URL(job.shareUrl).origin;
  const inserted = await database.prepare(`
    INSERT OR IGNORE INTO deliveries
      (id, status, channel_id, message_ts, thread_ts, source_origin, attempts, claim_id, lease_until, updated_at)
    VALUES (?, 'transferring', ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(job.id, job.channelId, job.messageTs, job.threadTs, origin, claimId, now + leaseMilliseconds, now).run();
  if (inserted.meta.changes === 1) return claimId;
  const reclaimed = await database.prepare(`
    UPDATE deliveries
    SET attempts = attempts + 1, claim_id = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND status = 'transferring' AND lease_until <= ?
  `).bind(claimId, now + leaseMilliseconds, now, job.id, now).run();
  return reclaimed.meta.changes === 1 ? claimId : null;
};

export const finishDelivery = async (
  database: DeliveryDatabase,
  id: string,
  claimId: string,
  status: "succeeded" | "failed" | "needs-review",
  now: number,
  errorCode: string | null = null,
  slackFileId: string | null = null,
): Promise<boolean> => {
  const result = await database.prepare(`
    UPDATE deliveries
    SET status = ?, lease_until = NULL, last_error_code = ?, slack_file_id = ?, updated_at = ?
    WHERE id = ? AND claim_id = ? AND status IN ('transferring', 'needs-review')
  `).bind(status, errorCode, slackFileId, now, id, claimId).run();
  return result.meta.changes === 1;
};

export const beginCompletion = async (
  database: DeliveryDatabase,
  id: string,
  claimId: string,
  now: number,
): Promise<boolean> => {
  const result = await database.prepare(`
    UPDATE deliveries
    SET status = 'needs-review', lease_until = NULL,
        last_error_code = 'slack_completion_uncertain', updated_at = ?
    WHERE id = ? AND claim_id = ? AND status = 'transferring'
  `).bind(now, id, claimId).run();
  return result.meta.changes === 1;
};

export const scheduleRetry = async (
  database: DeliveryDatabase,
  id: string,
  claimId: string,
  errorCode: string,
  now: number,
): Promise<boolean> => {
  const result = await database.prepare(`
    UPDATE deliveries
    SET lease_until = ?, last_error_code = ?, updated_at = ?
    WHERE id = ? AND claim_id = ? AND status = 'transferring'
  `).bind(now, errorCode, now, id, claimId).run();
  return result.meta.changes === 1;
};
