import { sha256 } from "../storage/crypto";

export const AGENT_TOKEN_SCOPE = "artifact:create" as const;
export const AGENT_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_CODE_LIFETIME_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const DEVICE_MAX_POLL_ATTEMPTS = 60;

export interface AgentPrincipal {
  readonly id: string;
  readonly tokenHash: string;
  readonly subject: string;
  readonly email: string;
  readonly scope: typeof AGENT_TOKEN_SCOPE;
  readonly expiresAt: number;
}

interface AgentTokenRow {
  id: string;
  token_hash: string;
  identity_subject: string;
  identity_email: string;
  scope: string;
  expires_at: number;
  revoked_at: number | null;
}

export const createOpaqueToken = (prefix = ""): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
};

export class AgentTokenRepository {
  public constructor(
    private readonly database: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  public async authenticate(plaintextToken: string): Promise<AgentPrincipal | null> {
    const tokenHash = await sha256(plaintextToken);
    const row = await this.database
      .prepare(
        `SELECT id, token_hash, identity_subject, identity_email, scope, expires_at, revoked_at
         FROM agent_tokens
         WHERE token_hash = ? AND scope = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(tokenHash, AGENT_TOKEN_SCOPE, this.now())
      .first<AgentTokenRow>();
    if (row === null || row.scope !== AGENT_TOKEN_SCOPE) return null;
    return {
      id: row.id,
      tokenHash: row.token_hash,
      subject: row.identity_subject,
      email: row.identity_email,
      scope: AGENT_TOKEN_SCOPE,
      expiresAt: row.expires_at,
    };
  }

  public async revoke(principal: AgentPrincipal): Promise<boolean> {
    const revokedAt = this.now();
    const [tokenResult] = await this.database.batch([
      this.database
        .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(revokedAt, principal.id),
      this.database
        .prepare(
          "UPDATE device_signing_keys SET revoked_at = ? WHERE agent_token_id = ? AND revoked_at IS NULL",
        )
        .bind(revokedAt, principal.id),
    ]);
    return tokenResult?.meta.changes === 1;
  }
}
