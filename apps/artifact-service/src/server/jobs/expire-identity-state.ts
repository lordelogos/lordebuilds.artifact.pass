export interface ExpireIdentityStateResult {
  readonly deviceAuthorizations: number;
  readonly agentTokens: number;
  readonly rateLimits: number;
  readonly oauthTransactions: number;
  readonly webSessions: number;
}

export type IdentityStateDatabase = Pick<D1Database, "prepare">;

const deleteBatch = async (
  database: IdentityStateDatabase,
  table: "device_authorizations" | "agent_tokens" | "request_rate_limits" | "oauth_transactions" | "web_sessions",
  predicate: string,
  now: number,
  limit: number,
): Promise<number> => {
  const result = await database.prepare(
    `DELETE FROM ${table}
     WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?)`,
  ).bind(now, limit).run();
  return result.meta.changes;
};

const deleteExpiredOrRevokedBatch = async (
  database: IdentityStateDatabase,
  table: "agent_tokens" | "web_sessions",
  now: number,
  limit: number,
): Promise<number> => {
  const result = await database.prepare(
    `WITH candidates AS (
       SELECT rowid, 0 AS priority FROM (
         SELECT rowid FROM ${table} WHERE revoked_at IS NOT NULL LIMIT ?
       )
       UNION ALL
       SELECT rowid, 1 AS priority FROM (
         SELECT rowid FROM ${table} WHERE expires_at <= ? LIMIT ?
       )
     ), eligible AS (
       SELECT rowid
       FROM candidates
       GROUP BY rowid
       ORDER BY MIN(priority), rowid
       LIMIT ?
     )
     DELETE FROM ${table}
     WHERE rowid IN (SELECT rowid FROM eligible)`,
  ).bind(limit, now, limit, limit).run();
  return result.meta.changes;
};

export const expireIdentityState = async (
  database: IdentityStateDatabase,
  now: number,
  limit = 100,
): Promise<ExpireIdentityStateResult> => ({
  deviceAuthorizations: await deleteBatch(database, "device_authorizations", "expires_at <= ?", now, limit),
  agentTokens: await deleteExpiredOrRevokedBatch(database, "agent_tokens", now, limit),
  rateLimits: await deleteBatch(database, "request_rate_limits", "expires_at <= ?", now, limit),
  oauthTransactions: await deleteBatch(database, "oauth_transactions", "expires_at <= ?", now, limit),
  webSessions: await deleteExpiredOrRevokedBatch(database, "web_sessions", now, limit),
});
