import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";
import { expireIdentityState } from "../src/server/jobs/expire-identity-state";

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
});
