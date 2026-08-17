import { Hono } from "hono";

import {
  AGENT_TOKEN_LIFETIME_MS,
  AGENT_TOKEN_SCOPE,
  DEVICE_CODE_LIFETIME_MS,
  DEVICE_MAX_POLL_ATTEMPTS,
  DEVICE_POLL_INTERVAL_SECONDS,
  createOpaqueToken,
} from "../auth/agent-token";
import {
  requireAccess,
  type ArtifactHonoEnvironment,
  type AuthorizationOptions,
} from "../middleware/authorize";
import { ArtifactError } from "../storage/artifact-error";
import { sha256 } from "../storage/crypto";

interface DeviceAuthorizationRow {
  id: string;
  device_code_hash: string;
  code_challenge: string;
  status: "pending" | "approved" | "consumed";
  expires_at: number;
  next_poll_at: number;
  poll_attempts: number;
  identity_subject: string | null;
  identity_email: string | null;
  agent_token_id: string | null;
}

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const DEVICE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DEVICE_RATE_LIMIT_REQUESTS = 10;

const consumeDeviceRateLimit = async (
  database: D1Database,
  source: string,
  timestamp: number,
): Promise<void> => {
  const bucketKey = await sha256(`device:${source}`);
  const row = await database.prepare(
    `INSERT INTO request_rate_limits (bucket_key, window_start, request_count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       window_start = CASE
         WHEN request_rate_limits.expires_at <= excluded.window_start THEN excluded.window_start
         ELSE request_rate_limits.window_start
       END,
       request_count = CASE
         WHEN request_rate_limits.expires_at <= excluded.window_start THEN 1
         ELSE request_rate_limits.request_count + 1
       END,
       expires_at = CASE
         WHEN request_rate_limits.expires_at <= excluded.window_start THEN excluded.expires_at
         ELSE request_rate_limits.expires_at
       END
     RETURNING request_count`,
  )
    .bind(bucketKey, timestamp, timestamp + DEVICE_RATE_LIMIT_WINDOW_MS)
    .first<{ readonly request_count: number }>();
  if (row === null || row.request_count > DEVICE_RATE_LIMIT_REQUESTS) {
    throw new ArtifactError("forbidden", "Too many device authorization requests", 429);
  }
};

const parseJson = async (request: Request): Promise<Record<string, unknown>> => {
  const value = await request.json().catch(() => null);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactError("malformed_upload", "Expected a JSON object", 400);
  }
  return value as Record<string, unknown>;
};

const parseApprovalBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") === true) {
    const form = await request.formData();
    return { user_code: form.get("user_code") };
  }
  return parseJson(request);
};

const approvalPage = (userCode: string, nonce: string, approved = false): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${approved ? "Connection approved" : "Approve Artifact Share"}</title>
<style nonce="${nonce}">html{color:#24241f;background:#f7f5ef;font-family:Avenir,"Helvetica Neue",sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(520px,calc(100% - 36px));padding:42px;background:#fffefa;border:1px solid #d8d5ca;border-radius:8px}h1{margin:0 0 14px;font:400 2.8rem/1 Georgia,serif;letter-spacing:-.04em}p{color:#66645e;line-height:1.6}.code{display:block;margin:24px 0;padding:14px;background:#f1efe8;border:1px solid #d8d5ca;font:700 1rem/1.2 ui-monospace,monospace;letter-spacing:.08em;text-align:center}button{width:100%;padding:14px;border:0;border-radius:5px;background:#24241f;color:white;font:700 .9rem Avenir,sans-serif;cursor:pointer}button:focus-visible{outline:3px solid #1f6c9f;outline-offset:3px}</style></head>
<body><main class="card"><h1>${approved ? "Connected." : "Approve this agent?"}</h1><p>${approved ? "The one-time code has been approved. Return to your terminal; the scoped token will be delivered there once and is never shown in this page." : "Only approve a code you just requested from your own terminal. This grants artifact:create access for 30 days."}</p>${approved ? "" : `<span class="code">${userCode}</span><form method="post" action="/connect/approve"><input type="hidden" name="user_code" value="${userCode}"><button type="submit">Approve connection</button></form>`}</main></body></html>`;

const approvalHeaders = (nonce: string) => ({
  ...RESPONSE_HEADERS,
  "Referrer-Policy": "same-origin",
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
});

const createApprovalNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const requiredString = (
  value: unknown,
  field: string,
  pattern: RegExp,
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ArtifactError("malformed_upload", `${field} is invalid`, 400);
  }
  return value;
};

const requireSameOrigin = (request: Request): void => {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) {
    throw new ArtifactError("not_found", "Route is unavailable", 404);
  }
};

const createUserCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const pkceChallenge = async (verifier: string): Promise<string> =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );

const findDeviceByCode = async (
  database: D1Database,
  deviceCode: string,
): Promise<DeviceAuthorizationRow | null> =>
  database
    .prepare("SELECT * FROM device_authorizations WHERE device_code_hash = ?")
    .bind(await sha256(deviceCode))
    .first<DeviceAuthorizationRow>();

const findDeviceByUserCode = async (
  database: D1Database,
  userCode: string,
): Promise<DeviceAuthorizationRow | null> =>
  database
    .prepare("SELECT * FROM device_authorizations WHERE user_code_hash = ?")
    .bind(await sha256(userCode))
    .first<DeviceAuthorizationRow>();

export const createConnectRouter = (options: AuthorizationOptions = {}) => {
  const router = new Hono<ArtifactHonoEnvironment>();
  const now = options.now ?? Date.now;

  router.post("/device", async (context) => {
    const body = await parseJson(context.req.raw);
    const codeChallenge = requiredString(
      body.code_challenge,
      "code_challenge",
      /^[A-Za-z0-9_-]{43}$/u,
    );
    if (body.code_challenge_method !== "S256") {
      throw new ArtifactError("malformed_upload", "code_challenge_method must be S256", 400);
    }
    const createdAt = now();
    await consumeDeviceRateLimit(
      context.env.ARTIFACT_DB,
      context.req.header("cf-connecting-ip") ?? "unknown",
      createdAt,
    );
    const deviceCode = createOpaqueToken();
    const userCode = createUserCode();
    const expiresAt = createdAt + DEVICE_CODE_LIFETIME_MS;
    await context.env.ARTIFACT_DB.prepare(
      `INSERT INTO device_authorizations (
        id, device_code_hash, user_code_hash, code_challenge, status, created_at,
        expires_at, next_poll_at, poll_attempts
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 0)`,
    )
      .bind(
        crypto.randomUUID(),
        await sha256(deviceCode),
        await sha256(userCode),
        codeChallenge,
        createdAt,
        expiresAt,
        createdAt,
      )
      .run();

    return context.json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: new URL("/connect/approve", context.req.url).toString(),
        expires_in: Math.floor(DEVICE_CODE_LIFETIME_MS / 1000),
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      },
      201,
      RESPONSE_HEADERS,
    );
  });

  router.get("/approve", requireAccess(options), async (context) => {
    const userCode = context.req.query("user_code");
    if (userCode === undefined) throw new ArtifactError("not_found", "Authorization is unavailable", 404);
    const authorization = await findDeviceByUserCode(context.env.ARTIFACT_DB, userCode);
    if (
      authorization === null ||
      authorization.status !== "pending" ||
      authorization.expires_at <= now()
    ) {
      throw new ArtifactError("not_found", "Authorization is unavailable", 404);
    }
    if (context.req.query("format") === "html") {
      const nonce = createApprovalNonce();
      return context.html(approvalPage(userCode, nonce), 200, approvalHeaders(nonce));
    }
    return context.json(
      {
        user_code: userCode,
        expires_at: new Date(authorization.expires_at).toISOString(),
      },
      200,
      RESPONSE_HEADERS,
    );
  });

  router.post("/approve", requireAccess(options), async (context) => {
    requireSameOrigin(context.req.raw);
    const formSubmission = context.req.header("content-type")?.startsWith("application/x-www-form-urlencoded") === true;
    const body = await parseApprovalBody(context.req.raw);
    const userCode = requiredString(body.user_code, "user_code", /^[A-Za-z0-9_-]{12,32}$/u);
    const identity = context.get("accessIdentity");
    const result = await context.env.ARTIFACT_DB.prepare(
      `UPDATE device_authorizations
       SET status = 'approved', identity_subject = ?, identity_email = ?, approved_at = ?
       WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`,
    )
      .bind(identity.subject, identity.email, now(), await sha256(userCode), now())
      .run();
    if (result.meta.changes !== 1) {
      throw new ArtifactError("forbidden", "Authorization cannot be approved", 409);
    }
    if (formSubmission) {
      const nonce = createApprovalNonce();
      return context.html(approvalPage(userCode, nonce, true), 200, approvalHeaders(nonce));
    }
    return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
  });

  router.post("/token", async (context) => {
    const body = await parseJson(context.req.raw);
    const deviceCode = requiredString(body.device_code, "device_code", /^[A-Za-z0-9_-]{43}$/u);
    const verifier = requiredString(
      body.code_verifier,
      "code_verifier",
      /^[A-Za-z0-9._~-]{43,128}$/u,
    );
    const authorization = await findDeviceByCode(context.env.ARTIFACT_DB, deviceCode);
    if (authorization === null) throw new ArtifactError("not_found", "Authorization is unavailable", 404);
    const currentTime = now();
    if (authorization.expires_at <= currentTime) {
      throw new ArtifactError("expired", "Authorization expired", 410);
    }
    if ((await pkceChallenge(verifier)) !== authorization.code_challenge) {
      throw new ArtifactError("forbidden", "PKCE verification failed", 400);
    }
    if (authorization.status === "consumed") {
      if (authorization.agent_token_id === null) {
        throw new ArtifactError("internal_error", "Consumed authorization has no token", 500);
      }
      await context.env.ARTIFACT_DB.prepare(
        "UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
        .bind(currentTime, authorization.agent_token_id)
        .run();
      throw new ArtifactError("forbidden", "Authorization was already consumed", 409);
    }
    if (authorization.status === "pending") {
      if (
        authorization.poll_attempts >= DEVICE_MAX_POLL_ATTEMPTS ||
        currentTime < authorization.next_poll_at
      ) {
        await context.env.ARTIFACT_DB.prepare(
          "UPDATE device_authorizations SET poll_attempts = poll_attempts + 1 WHERE id = ?",
        )
          .bind(authorization.id)
          .run();
        throw new ArtifactError("forbidden", "Polling too quickly", 429);
      }
      await context.env.ARTIFACT_DB.prepare(
        `UPDATE device_authorizations
         SET poll_attempts = poll_attempts + 1, next_poll_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
        .bind(currentTime + DEVICE_POLL_INTERVAL_SECONDS * 1000, authorization.id)
        .run();
      return context.json(
        { status: "authorization_pending", interval: DEVICE_POLL_INTERVAL_SECONDS },
        202,
        RESPONSE_HEADERS,
      );
    }
    if (authorization.identity_subject === null || authorization.identity_email === null) {
      throw new ArtifactError("internal_error", "Approved authorization has no identity", 500);
    }

    const plaintextToken = createOpaqueToken("as_");
    const tokenHash = await sha256(plaintextToken);
    const tokenId = crypto.randomUUID();
    const expiresAt = currentTime + AGENT_TOKEN_LIFETIME_MS;
    const statements = [
      context.env.ARTIFACT_DB
        .prepare(
          `UPDATE device_authorizations
           SET status = 'consumed', consumed_at = ?, agent_token_id = ?
           WHERE id = ? AND status = 'approved' AND agent_token_id IS NULL`,
        )
        .bind(currentTime, tokenId, authorization.id),
      context.env.ARTIFACT_DB
        .prepare(
          `INSERT INTO agent_tokens (
            id, token_hash, identity_subject, identity_email, scope, created_at, expires_at
          )
          SELECT ?, ?, identity_subject, identity_email, ?, ?, ?
          FROM device_authorizations
          WHERE id = ? AND status = 'consumed' AND agent_token_id = ? AND expires_at > ?`,
        )
        .bind(
          tokenId,
          tokenHash,
          AGENT_TOKEN_SCOPE,
          currentTime,
          expiresAt,
          authorization.id,
          tokenId,
          currentTime,
        ),
    ];
    const results = await context.env.ARTIFACT_DB.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new ArtifactError("forbidden", "Authorization was already consumed", 409);
    }

    return context.json(
      {
        access_token: plaintextToken,
        token_type: "Bearer",
        scope: AGENT_TOKEN_SCOPE,
        expires_in: Math.floor(AGENT_TOKEN_LIFETIME_MS / 1000),
      },
      200,
      RESPONSE_HEADERS,
    );
  });

  return router;
};
