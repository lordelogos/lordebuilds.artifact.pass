import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import { createOpaqueToken } from "./agent-token";
import { sha256 } from "../storage/crypto";

export const PUBLIC_SESSION_COOKIE = "__Host-artifactpass_session";
export const PUBLIC_OAUTH_COOKIE = "__Host-artifactpass_oauth";
export const PUBLIC_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;

export interface HumanIdentity {
  readonly subject: string;
  readonly email: string;
}

export interface PublicOAuthCookie {
  readonly state: string;
  readonly codeVerifier?: string;
}

const cookieValue = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
};

export const readPublicOAuthCookie = (request: Request): PublicOAuthCookie | null => {
  const value = cookieValue(request, PUBLIC_OAUTH_COOKIE);
  if (value === null) return null;
  const [state, codeVerifier, ...unexpected] = value.split(".");
  if (
    unexpected.length > 0 ||
    state === undefined ||
    !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
    (codeVerifier !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(codeVerifier))
  ) {
    return null;
  }
  return { state, ...(codeVerifier === undefined ? {} : { codeVerifier }) };
};

export const readPublicSession = async (
  request: Request,
  bindings: ArtifactServiceBindings,
  now = Date.now(),
): Promise<HumanIdentity | null> => {
  const token = cookieValue(request, PUBLIC_SESSION_COOKIE);
  if (token === null || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  return bindings.ARTIFACT_DB.prepare(
    `SELECT identity_subject AS subject, identity_email AS email
     FROM web_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(await sha256(token), now).first<HumanIdentity>();
};

export const createPublicSession = async (
  database: D1Database,
  identity: HumanIdentity,
  now = Date.now(),
): Promise<{ readonly token: string; readonly expiresAt: number }> => {
  const token = createOpaqueToken();
  const expiresAt = now + PUBLIC_SESSION_LIFETIME_MS;
  await database.prepare(
    `INSERT INTO web_sessions (
       token_hash, identity_subject, identity_email, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).bind(await sha256(token), identity.subject, identity.email, now, expiresAt).run();
  return { token, expiresAt };
};

export const publicSessionCookie = (token: string, expiresAt: number): string =>
  `${PUBLIC_SESSION_COOKIE}=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;

export const publicOAuthCookie = (
  state: string,
  expiresAt: number,
  codeVerifier?: string,
): string =>
  `${PUBLIC_OAUTH_COOKIE}=${state}${codeVerifier === undefined ? "" : `.${codeVerifier}`}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;

export const expiredPublicOAuthCookie = (): string =>
  `${PUBLIC_OAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export const expiredPublicSessionCookie = (): string =>
  `${PUBLIC_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export const revokePublicSession = async (
  request: Request,
  database: D1Database,
  now = Date.now(),
): Promise<void> => {
  const token = cookieValue(request, PUBLIC_SESSION_COOKIE);
  if (token === null || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return;
  await database.prepare(
    "UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(now, await sha256(token)).run();
};
