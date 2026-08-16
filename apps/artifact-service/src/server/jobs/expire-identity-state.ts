export interface ExpireIdentityStateResult {
  readonly deviceAuthorizations: number;
  readonly agentTokens: number;
  readonly rateLimits: number;
}

const deleteBatch = async (
  database: D1Database,
  table: "device_authorizations" | "agent_tokens" | "request_rate_limits",
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

export const expireIdentityState = async (
  database: D1Database,
  now: number,
  limit = 100,
): Promise<ExpireIdentityStateResult> => ({
  deviceAuthorizations: await deleteBatch(database, "device_authorizations", "expires_at <= ?", now, limit),
  agentTokens: await deleteBatch(
    database,
    "agent_tokens",
    "expires_at <= ? OR revoked_at IS NOT NULL",
    now,
    limit,
  ),
  rateLimits: await deleteBatch(database, "request_rate_limits", "expires_at <= ?", now, limit),
});
