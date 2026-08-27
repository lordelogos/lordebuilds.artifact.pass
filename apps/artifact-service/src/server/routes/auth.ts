import { Hono } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import {
  OAUTH_TRANSACTION_LIFETIME_MS,
  createPublicSession,
  expiredPublicOAuthCookie,
  expiredPublicSessionCookie,
  publicOAuthCookie,
  publicSessionCookie,
  readPublicOAuthState,
  revokePublicSession,
  type HumanIdentity,
} from "../auth/public-session";
import { createOpaqueToken } from "../auth/agent-token";
import { consumeRequestRateLimit } from "../auth/rate-limit";
import type { ArtifactHonoEnvironment } from "../middleware/authorize";
import { ArtifactError } from "../storage/artifact-error";
import { sha256 } from "../storage/crypto";

type OAuthProvider = "google" | "github";

export interface AuthRouterOptions {
  readonly now?: () => number;
  readonly oauthFetch?: typeof globalThis.fetch;
}

interface OAuthTransaction {
  readonly return_to: string;
}

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const OAUTH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const OAUTH_RATE_LIMIT_REQUESTS = 20;
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;

const requireSameOrigin = (request: Request): void => {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ArtifactError("not_found", "Route is unavailable", 404);
  }
};

const safeReturnTo = (value: string | undefined): string => {
  const candidate = value ?? "/upload";
  const containsControlCharacter = [...candidate].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.startsWith("/\\") ||
    candidate.includes("\\") ||
    containsControlCharacter
  ) {
    throw new ArtifactError("malformed_upload", "return_to must be a local ArtifactPass path", 400);
  }
  return candidate;
};

const providerCredentials = (
  provider: OAuthProvider,
  bindings: ArtifactServiceBindings,
): { readonly clientId: string; readonly clientSecret: string } => {
  const clientId = provider === "google"
    ? bindings.GOOGLE_OAUTH_CLIENT_ID
    : bindings.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = provider === "google"
    ? bindings.GOOGLE_OAUTH_CLIENT_SECRET
    : bindings.GITHUB_OAUTH_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    throw new ArtifactError("internal_error", `${provider} authentication is unavailable`, 503);
  }
  return { clientId, clientSecret };
};

const signInPage = (returnTo: string): string => {
  const encodedReturnTo = encodeURIComponent(returnTo);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ArtifactPass</title>
<style>html{color:#24241f;background:#f7f5ef;font-family:Avenir,"Helvetica Neue",sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(520px,calc(100% - 36px));padding:42px;background:#fffefa;border:1px solid #d8d5ca;border-radius:8px}h1{margin:0 0 14px;font:400 2.8rem/1 Georgia,serif;letter-spacing:-.04em}p{color:#66645e;line-height:1.6}.actions{display:grid;gap:12px;margin-top:28px}a{display:block;padding:14px;border:1px solid #24241f;border-radius:5px;color:#24241f;text-align:center;text-decoration:none;font-weight:700}a:first-child{background:#24241f;color:white}a:focus-visible{outline:3px solid #1f6c9f;outline-offset:3px}</style></head>
<body><main class="card"><h1>Sign in to ArtifactPass</h1><p>Connect your agent to create temporary artifact links. ArtifactPass never receives your Google or GitHub password.</p><div class="actions"><a href="/auth/login/google?return_to=${encodedReturnTo}">Continue with Google</a><a href="/auth/login/github?return_to=${encodedReturnTo}">Continue with GitHub</a></div></main></body></html>`;
};

const authorizationUrl = (
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  state: string,
): URL => {
  const url = new URL(provider === "google"
    ? "https://accounts.google.com/o/oauth2/v2/auth"
    : "https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", provider === "google" ? "openid email" : "read:user user:email");
  if (provider === "google") url.searchParams.set("prompt", "select_account");
  return url;
};

const jsonFrom = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new ArtifactError("forbidden", "Authentication provider rejected the request", 502);
  return response.json<T>();
};

const fetchOAuth = (
  fetchImplementation: typeof globalThis.fetch,
  input: string,
  init: RequestInit = {},
): Promise<Response> => fetchImplementation(input, {
  ...init,
  signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
});

const exchangeGoogle = async (
  code: string,
  redirectUri: string,
  credentials: { readonly clientId: string; readonly clientSecret: string },
  fetchImplementation: typeof globalThis.fetch,
): Promise<HumanIdentity> => {
  const token = await jsonFrom<{ readonly access_token?: string }>(await fetchOAuth(fetchImplementation,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    },
  ));
  if (token.access_token === undefined) throw new ArtifactError("forbidden", "Google returned no access token", 502);
  const profile = await jsonFrom<{
    readonly sub?: string;
    readonly email?: string;
    readonly email_verified?: boolean;
  }>(await fetchOAuth(fetchImplementation, "https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }));
  if (profile.sub === undefined || profile.email === undefined || profile.email_verified !== true) {
    throw new ArtifactError("forbidden", "Google account has no verified email address", 403);
  }
  return { subject: `google:${profile.sub}`, email: profile.email.toLowerCase() };
};

const exchangeGitHub = async (
  code: string,
  redirectUri: string,
  credentials: { readonly clientId: string; readonly clientSecret: string },
  fetchImplementation: typeof globalThis.fetch,
): Promise<HumanIdentity> => {
  const token = await jsonFrom<{ readonly access_token?: string }>(await fetchOAuth(fetchImplementation,
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: redirectUri,
      }),
    },
  ));
  if (token.access_token === undefined) throw new ArtifactError("forbidden", "GitHub returned no access token", 502);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token.access_token}`,
    "User-Agent": "ArtifactPass",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const [profile, emails] = await Promise.all([
    fetchOAuth(fetchImplementation, "https://api.github.com/user", { headers })
      .then((response) => jsonFrom<{ readonly id?: number }>(response)),
    fetchOAuth(fetchImplementation, "https://api.github.com/user/emails", { headers })
      .then((response) => jsonFrom<readonly {
        readonly email?: string;
        readonly primary?: boolean;
        readonly verified?: boolean;
      }[]>(response)),
  ]);
  const email = emails.find((candidate) => candidate.primary === true && candidate.verified === true)?.email
    ?? emails.find((candidate) => candidate.verified === true)?.email;
  if (profile.id === undefined || email === undefined) {
    throw new ArtifactError("forbidden", "GitHub account has no verified email address", 403);
  }
  return { subject: `github:${profile.id}`, email: email.toLowerCase() };
};

export const createAuthRouter = (options: AuthRouterOptions = {}) => {
  const router = new Hono<ArtifactHonoEnvironment>();
  const now = options.now ?? Date.now;
  const oauthFetch = options.oauthFetch ?? globalThis.fetch;

  router.get("/sign-in", (context) => {
    const returnTo = safeReturnTo(context.req.query("return_to"));
    return context.html(signInPage(returnTo), 200, {
      ...RESPONSE_HEADERS,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    });
  });

  router.get("/login/:provider", async (context) => {
    const provider = context.req.param("provider");
    if (provider !== "google" && provider !== "github") {
      throw new ArtifactError("not_found", "Authentication provider is unavailable", 404);
    }
    const returnTo = safeReturnTo(context.req.query("return_to"));
    const credentials = providerCredentials(provider, context.env);
    const state = createOpaqueToken();
    const createdAt = now();
    await consumeRequestRateLimit({
      database: context.env.ARTIFACT_DB,
      namespace: "oauth",
      source: context.req.header("cf-connecting-ip") ?? "unknown",
      timestamp: createdAt,
      windowMilliseconds: OAUTH_RATE_LIMIT_WINDOW_MS,
      maximumRequests: OAUTH_RATE_LIMIT_REQUESTS,
      errorMessage: "Too many authentication requests",
    });
    await context.env.ARTIFACT_DB.prepare(
      `INSERT INTO oauth_transactions (state_hash, provider, return_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      await sha256(state),
      provider,
      returnTo,
      createdAt,
      createdAt + OAUTH_TRANSACTION_LIFETIME_MS,
    ).run();
    const redirectUri = new URL(`/auth/callback/${provider}`, context.req.url).toString();
    return new Response(null, {
      status: 302,
      headers: {
        ...RESPONSE_HEADERS,
        Location: authorizationUrl(provider, credentials.clientId, redirectUri, state).toString(),
        "Set-Cookie": publicOAuthCookie(state, createdAt + OAUTH_TRANSACTION_LIFETIME_MS),
      },
    });
  });

  router.get("/callback/:provider", async (context) => {
    const provider = context.req.param("provider");
    const code = context.req.query("code");
    const state = context.req.query("state");
    if (
      (provider !== "google" && provider !== "github") ||
      code === undefined ||
      state === undefined ||
      !/^[A-Za-z0-9_-]{43}$/u.test(state)
    ) {
      throw new ArtifactError("forbidden", "Authentication response is invalid", 400);
    }
    if (readPublicOAuthState(context.req.raw) !== state) {
      throw new ArtifactError("forbidden", "Authentication response is not bound to this browser", 400);
    }
    const transaction = await context.env.ARTIFACT_DB.prepare(
      `DELETE FROM oauth_transactions
       WHERE state_hash = ? AND provider = ? AND expires_at > ?
       RETURNING return_to`,
    ).bind(await sha256(state), provider, now()).first<OAuthTransaction>();
    if (transaction === null) {
      throw new ArtifactError("forbidden", "Authentication request expired or was already used", 400);
    }
    const credentials = providerCredentials(provider, context.env);
    const redirectUri = new URL(`/auth/callback/${provider}`, context.req.url).toString();
    const identity = provider === "google"
      ? await exchangeGoogle(code, redirectUri, credentials, oauthFetch)
      : await exchangeGitHub(code, redirectUri, credentials, oauthFetch);
    const session = await createPublicSession(context.env.ARTIFACT_DB, identity, now());
    const headers = new Headers({
      ...RESPONSE_HEADERS,
      Location: transaction.return_to,
    });
    headers.append("Set-Cookie", publicSessionCookie(session.token, session.expiresAt));
    headers.append("Set-Cookie", expiredPublicOAuthCookie());
    return new Response(null, {
      status: 302,
      headers,
    });
  });

  router.post("/logout", async (context) => {
    requireSameOrigin(context.req.raw);
    await revokePublicSession(context.req.raw, context.env.ARTIFACT_DB, now());
    return new Response(null, {
      status: 302,
      headers: {
        ...RESPONSE_HEADERS,
        Location: "/auth/sign-in",
        "Set-Cookie": expiredPublicSessionCookie(),
      },
    });
  });

  return router;
};
