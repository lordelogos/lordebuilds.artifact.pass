import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";
import {
  expireIdentityState,
  type IdentityStateDatabase,
} from "../src/server/jobs/expire-identity-state";

describe("expired identity cleanup", () => {
  beforeEach(async () => {
    await reset();
    await env.ARTIFACT_DB.exec(ARTIFACT_SCHEMA_SQL);
  });

  it("removes expired device, token, OAuth, session, and rate-limit state in bounded batches", async () => {
    await env.ARTIFACT_DB.batch([
      env.ARTIFACT_DB.prepare(
        `INSERT INTO device_authorizations
          (id, device_code_hash, user_code_hash, code_challenge, status, created_at, expires_at, next_poll_at, poll_attempts)
         VALUES ('device', 'device-hash', 'user-hash', 'challenge', 'pending', 1, 2, 1, 0)`,
      ),
      env.ARTIFACT_DB.prepare(
        `INSERT INTO agent_tokens
          (id, token_hash, identity_subject, identity_email, scope, created_at, expires_at, revoked_at)
         VALUES ('token', 'token-hash', 'subject', 'person@example.test', 'artifact:create', 1, 999999, 2)`,
      ),
      env.ARTIFACT_DB.prepare(
        `INSERT INTO request_rate_limits (bucket_key, window_start, request_count, expires_at)
         VALUES ('bucket', 1, 1, 2)`,
      ),
      env.ARTIFACT_DB.prepare(
        `INSERT INTO oauth_transactions (state_hash, provider, return_to, created_at, expires_at)
         VALUES ('state-hash', 'google', '/upload', 1, 2)`,
      ),
      env.ARTIFACT_DB.prepare(
        `INSERT INTO web_sessions
          (token_hash, identity_subject, identity_email, created_at, expires_at, revoked_at)
         VALUES ('session-hash', 'google:user', 'person@example.test', 1, 999999, 2)`,
      ),
    ]);

    await expect(expireIdentityState(env.ARTIFACT_DB, 3, 10)).resolves.toEqual({
      deviceAuthorizations: 1,
      agentTokens: 1,
      rateLimits: 1,
      oauthTransactions: 1,
      webSessions: 1,
    });
  });

  it("uses indexes for expired or revoked token and session cleanup", async () => {
    const preparedQueries: string[] = [];
    const recordingDatabase: IdentityStateDatabase = {
      prepare(query: string) {
        preparedQueries.push(query);
        return env.ARTIFACT_DB.prepare(query);
      },
    };

    await expireIdentityState(recordingDatabase, 3, 10);

    for (const table of ["agent_tokens", "web_sessions"] as const) {
      const query = preparedQueries.find((candidate) => candidate.includes(`FROM ${table}`));
      expect(query).toBeDefined();
      expect(query?.match(/LIMIT \?/gu)).toHaveLength(3);
      const plan = await env.ARTIFACT_DB.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(10, 3, 10, 10)
        .all<{ readonly detail: string }>();
      expect(plan.results.map((row) => row.detail).join("\n")).not.toContain(`SCAN ${table}`);
    }
  });

  it("prioritizes revoked state while keeping each cleanup result within the batch limit", async () => {
    const statements: D1PreparedStatement[] = [];
    for (const index of [1, 2, 3, 4]) {
      statements.push(
        env.ARTIFACT_DB.prepare(
          `INSERT INTO agent_tokens
            (id, token_hash, identity_subject, identity_email, scope, created_at, expires_at)
           VALUES (?, ?, 'subject', 'person@example.test', 'artifact:create', 1, 2)`,
        ).bind(`expired-token-${index}`, `expired-token-hash-${index}`),
        env.ARTIFACT_DB.prepare(
          `INSERT INTO web_sessions
            (token_hash, identity_subject, identity_email, created_at, expires_at)
           VALUES (?, 'google:user', 'person@example.test', 1, 2)`,
        ).bind(`expired-session-${index}`),
      );
    }
    statements.push(
      env.ARTIFACT_DB.prepare(
        `INSERT INTO agent_tokens
          (id, token_hash, identity_subject, identity_email, scope, created_at, expires_at, revoked_at)
         VALUES ('revoked-token', 'revoked-token-hash', 'subject', 'person@example.test', 'artifact:create', 1, 999999, 2)`,
      ),
      env.ARTIFACT_DB.prepare(
        `INSERT INTO web_sessions
          (token_hash, identity_subject, identity_email, created_at, expires_at, revoked_at)
         VALUES ('revoked-session', 'google:user', 'person@example.test', 1, 999999, 2)`,
      ),
    );
    await env.ARTIFACT_DB.batch(statements);

    const result = await expireIdentityState(env.ARTIFACT_DB, 3, 2);

    expect(result.agentTokens).toBe(2);
    expect(result.webSessions).toBe(2);
    await expect(env.ARTIFACT_DB.prepare(
      "SELECT id FROM agent_tokens WHERE id = 'revoked-token'",
    ).first()).resolves.toBeNull();
    await expect(env.ARTIFACT_DB.prepare(
      "SELECT token_hash FROM web_sessions WHERE token_hash = 'revoked-session'",
    ).first()).resolves.toBeNull();
    await expect(env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM agent_tokens",
    ).first<{ readonly count: number }>()).resolves.toEqual({ count: 3 });
    await expect(env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM web_sessions",
    ).first<{ readonly count: number }>()).resolves.toEqual({ count: 3 });
  });
});
