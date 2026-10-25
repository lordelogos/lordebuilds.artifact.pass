import type { QueuedArchiveJob } from "./event-receiver";

export interface DeliveryDatabase {
  prepare(sql: string): {
    bind(...values: (string | number | null)[]): {
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

const leaseMilliseconds = 10 * 60 * 1_000;

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
): Promise<boolean> => {
  const result = await database.prepare(`
    UPDATE deliveries
    SET status = ?, lease_until = NULL, updated_at = ?
    WHERE id = ? AND claim_id = ? AND status = 'transferring'
  `).bind(status, now, id, claimId).run();
  return result.meta.changes === 1;
};
