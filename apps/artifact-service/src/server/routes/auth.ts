import { Hono } from "hono";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
import { GitHubIcon, GoogleIcon } from "../../web/components/brand-icons";

type OAuthProvider = "google" | "github";
type AuthPageTheme = "dark" | "light";

const providerIconMarkup = {
  github: renderToStaticMarkup(createElement(GitHubIcon, { "aria-hidden": true, focusable: "false" })),
  google: renderToStaticMarkup(createElement(GoogleIcon, { "aria-hidden": true, focusable: "false" })),
} as const;

export interface AuthRouterOptions {
  readonly now?: () => number;
  readonly oauthFetch?: typeof globalThis.fetch;
}

interface OAuthTransaction {
  readonly return_to: string;
}

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
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

const authPageTheme = (value: string | undefined): AuthPageTheme => value === "light" ? "light" : "dark";

const authPageStyles = `
:root{--void:#0b0c0e;--graphite:#121418;--panel:rgba(255,255,255,.055);--panel-strong:rgba(255,255,255,.085);--line:rgba(255,255,255,.13);--line-strong:rgba(255,255,255,.22);--bone:#efefec;--ash:#b8babd;--slate:#797d82;--white:#f9f9f7;--ink:#17181a;--sans:"Avenir Next",Avenir,"Helvetica Neue",Helvetica,sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;color-scheme:dark}
:root[data-theme="light"]{--void:#f3f3f0;--graphite:#fafaf8;--panel:rgba(23,24,26,.045);--panel-strong:rgba(23,24,26,.075);--line:rgba(23,24,26,.13);--line-strong:rgba(23,24,26,.23);--bone:#1b1c1e;--ash:#4f5358;--slate:#696e74;--white:#111214;--ink:#f8f8f5;color-scheme:light}
*{box-sizing:border-box}html{min-width:320px;min-height:100%;color:var(--bone);background:var(--void);font-family:var(--sans);-webkit-font-smoothing:antialiased}body{min-height:100dvh;margin:0}.auth-shell{display:grid;width:min(440px,calc(100% - 32px));min-height:100dvh;margin:0 auto;padding:24px 0;align-content:center}.auth-brand{display:inline-flex;align-items:center;width:max-content;margin:0 0 16px;color:var(--bone);font-size:15px;font-weight:600;letter-spacing:-.03em}.brand-mark{position:relative;width:20px;height:20px;margin-right:9px;border:1px solid var(--line-strong);border-radius:6px}.brand-mark:before,.brand-mark:after{position:absolute;width:6px;height:6px;border:1px solid var(--ash);border-radius:2px;content:""}.brand-mark:before{top:3px;left:3px}.brand-mark:after{right:3px;bottom:3px}.auth-card{padding:28px;border:1px solid var(--line);border-radius:22px;background:var(--graphite);box-shadow:0 24px 70px rgba(0,0,0,.18)}.auth-eyebrow{display:flex;align-items:center;gap:9px;margin:0 0 20px;color:var(--slate);font:500 10px/1 var(--mono);text-transform:uppercase}.auth-eyebrow:before{width:18px;height:1px;background:linear-gradient(90deg,#b98458,#716de4,#557fbd);content:""}h1{margin:0;color:var(--bone);font-size:clamp(32px,8vw,42px);font-weight:500;line-height:1.02;letter-spacing:-.05em}.auth-copy{margin:18px 0 0;color:var(--ash);font-size:14px;line-height:1.55}.actions{display:grid;gap:10px;margin-top:26px}.provider{display:grid;grid-template-columns:30px 1fr auto;align-items:center;min-height:56px;padding:0 16px;border:1px solid var(--line-strong);border-radius:12px;color:var(--bone);background:var(--panel);text-decoration:none;font-size:13px;font-weight:500}.provider:hover{border-color:var(--bone);background:var(--panel-strong)}.provider:active{transform:translateY(1px) scale(.995)}.provider:focus-visible{outline:2px solid var(--bone);outline-offset:3px}.provider-icon{display:grid;width:18px;height:18px;color:var(--bone);place-items:center}.provider-icon svg{display:block;width:18px;height:18px}.provider-arrow{color:var(--slate);font:400 13px/1 var(--mono)}.privacy-note{margin:18px 0 0;padding-top:18px;border-top:1px solid var(--line);color:var(--slate);font-size:11px;line-height:1.5}.auth-footer{margin:14px 2px 0;color:var(--slate);font:400 9px/1 var(--mono);text-align:right}.complete-card{text-align:center}.complete-card .auth-eyebrow{justify-content:center}.complete-card p{margin:14px 0 0;color:var(--ash);font-size:13px;line-height:1.55}@media(max-width:480px){.auth-shell{width:calc(100% - 24px);padding:12px 0}.auth-card{padding:22px;border-radius:18px}.auth-brand{margin-left:2px}h1{font-size:34px}}@media(prefers-reduced-motion:reduce){*{transition-duration:0s!important}}
`;

const signInPage = (returnTo: string, theme: AuthPageTheme): string => {
  const encodedReturnTo = encodeURIComponent(returnTo);
  const isPopup = returnTo.startsWith("/auth/popup/complete");
  const introduction = isPopup
    ? "Sign in to continue. Your selected document stays in the original tab until you confirm the upload."
    : "Sign in to create temporary links or approve an agent connection.";
  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ArtifactPass</title>
<style>${authPageStyles}</style></head>
<body><main class="auth-shell"><header class="auth-brand"><span class="brand-mark" aria-hidden="true"></span>ArtifactPass</header><section class="auth-card"><p class="auth-eyebrow">Secure sign-in</p><h1>Continue to ArtifactPass.</h1><p class="auth-copy">${introduction}</p><div class="actions"><a class="provider" href="/auth/login/google?return_to=${encodedReturnTo}"><span class="provider-icon" data-provider="google">${providerIconMarkup.google}</span><span>Continue with Google</span><span class="provider-arrow" aria-hidden="true">→</span></a><a class="provider" href="/auth/login/github?return_to=${encodedReturnTo}"><span class="provider-icon" data-provider="github">${providerIconMarkup.github}</span><span>Continue with GitHub</span><span class="provider-arrow" aria-hidden="true">→</span></a></div><p class="privacy-note">ArtifactPass never receives your Google or GitHub password.</p></section><footer class="auth-footer">one file · one expiring URL</footer></main></body></html>`;
};

const popupCompletePage = (theme: AuthPageTheme): string => `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in to ArtifactPass</title>
<style>${authPageStyles}</style></head>
<body><main class="auth-shell"><header class="auth-brand"><span class="brand-mark" aria-hidden="true"></span>ArtifactPass</header><section class="auth-card complete-card"><p class="auth-eyebrow">Authentication complete</p><h1>Signed in.</h1><p id="popup-status">Returning to your document…</p></section></main><script src="/auth/popup-complete.js"></script></body></html>`;

const popupCompleteScript = `(() => {
  if (window.opener !== null && !window.opener.closed) {
    window.opener.postMessage({ type: "artifactpass:auth-complete" }, window.location.origin);
    window.close();
    window.setTimeout(() => {
      const status = document.querySelector("#popup-status");
      if (status !== null) status.textContent = "You can return to the ArtifactPass tab.";
    }, 500);
    return;
  }
  window.location.assign("/upload");
})();`;

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
    const theme = authPageTheme(context.req.query("theme"));
    return context.html(signInPage(returnTo, theme), 200, {
      ...RESPONSE_HEADERS,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    });
  });

  router.get("/popup/complete", (context) => context.html(popupCompletePage(
    authPageTheme(context.req.query("theme")),
  ), 200, {
    ...RESPONSE_HEADERS,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  }));

  router.get("/popup-complete.js", (context) => context.body(popupCompleteScript, 200, {
    ...RESPONSE_HEADERS,
    "Content-Type": "application/javascript; charset=UTF-8",
    "Content-Security-Policy": "default-src 'none'",
  }));

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
