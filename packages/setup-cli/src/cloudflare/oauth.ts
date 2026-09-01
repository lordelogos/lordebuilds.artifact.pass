import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export const CLOUDFLARE_OAUTH_REDIRECT = "http://127.0.0.1:8976/oauth/callback";
export const CLOUDFLARE_OAUTH_AUTHORIZE_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOKE_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";

const commonScopes = Object.freeze([
  "workers-scripts.write",
  "workers-routes.write",
  "d1.write",
  "workers-r2.write",
  "workers-r2-bucket-item.write",
  "zone.read",
  "access.write",
  "access-org.read",
  "access-idp.read",
  "memberships.read",
  "user-details.read",
]);

export const CLOUDFLARE_OAUTH_SCOPE_PROFILES = Object.freeze({
  companyLogin: commonScopes,
  emailCode: Object.freeze([...commonScopes, "access-idp.write", "offline_access"]),
});

export type CloudflareOAuthProfile = keyof typeof CLOUDFLARE_OAUTH_SCOPE_PROFILES;

export interface CloudflareOAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly scope: string;
  readonly token_type: string;
}

export interface CloudflareOAuthAuthorization {
  readonly profile: CloudflareOAuthProfile;
  readonly token: CloudflareOAuthTokenResponse;
  readonly grantedScopes: readonly string[];
}

export interface CloudflareOAuthDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly onManualOpen?: (url: string) => void;
  readonly timeoutMilliseconds?: number;
  readonly randomBytes?: (size: number) => Buffer;
}

const base64Url = (value: Buffer): string => value.toString("base64url");
const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const exactScopes = (scopeValue: string): readonly string[] =>
  [...new Set(scopeValue.split(/[\s,]+/u).map((scope) => scope.trim()).filter(Boolean))].sort();

const expectedScopes = (profile: CloudflareOAuthProfile): readonly string[] =>
  [...CLOUDFLARE_OAUTH_SCOPE_PROFILES[profile]].sort();

export const assertExactCloudflareOAuthScopes = (
  profile: CloudflareOAuthProfile,
  scopeValue: string,
): readonly string[] => {
  const granted = exactScopes(scopeValue);
  const expected = expectedScopes(profile);
  if (JSON.stringify(granted) !== JSON.stringify(expected)) {
    const missing = expected.filter((scope) => !granted.includes(scope));
    const unexpected = granted.filter((scope) => !expected.includes(scope));
    throw new Error(
      `Cloudflare granted the wrong OAuth scopes. Missing: ${missing.join(", ") || "none"}. ` +
      `Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
  return granted;
};

const validateTokenResponse = (value: unknown): CloudflareOAuthTokenResponse => {
  if (value === null || typeof value !== "object") throw new Error("Cloudflare returned a malformed OAuth token response");
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.access_token !== "string" || candidate.access_token.length < 20 || candidate.access_token.length > 4096 ||
    (candidate.refresh_token !== undefined && (typeof candidate.refresh_token !== "string" || candidate.refresh_token.length < 20 || candidate.refresh_token.length > 4096)) ||
    typeof candidate.expires_in !== "number" || !Number.isFinite(candidate.expires_in) || candidate.expires_in <= 0 || candidate.expires_in > 86_400 ||
    typeof candidate.scope !== "string" || candidate.scope.length === 0 || candidate.scope.length > 4096 ||
    typeof candidate.token_type !== "string" || candidate.token_type.toLowerCase() !== "bearer"
  ) {
    throw new Error("Cloudflare returned a malformed OAuth token response");
  }
  return candidate as unknown as CloudflareOAuthTokenResponse;
};

const postTokenForm = async (
  endpoint: string,
  parameters: Readonly<Record<string, string>>,
  fetchImplementation: typeof globalThis.fetch,
): Promise<CloudflareOAuthTokenResponse> => {
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cloudflare OAuth token request failed (${response.status})`);
  return validateTokenResponse(await response.json().catch(() => null));
};

export const refreshCloudflareOAuthToken = async (
  clientId: string,
  refreshToken: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<CloudflareOAuthTokenResponse> => postTokenForm(CLOUDFLARE_OAUTH_TOKEN_ENDPOINT, {
  grant_type: "refresh_token",
  client_id: clientId,
  refresh_token: refreshToken,
}, fetchImplementation);

export const revokeCloudflareOAuthToken = async (
  clientId: string,
  token: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> => {
  const response = await fetchImplementation(CLOUDFLARE_OAUTH_REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cloudflare OAuth token revocation failed (${response.status})`);
};

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));

interface AuthorizationCode {
  readonly code: string;
  readonly verifier: string;
}

export const authorizeCloudflareOAuth = async (
  clientId: string,
  profile: CloudflareOAuthProfile,
  dependencies: CloudflareOAuthDependencies,
): Promise<CloudflareOAuthAuthorization> => {
  if (!/^[a-f0-9]{32}$/u.test(clientId)) throw new Error("ArtifactPass Cloudflare OAuth client ID is not configured");
  const random = dependencies.randomBytes ?? randomBytes;
  const state = base64Url(random(24));
  const verifier = base64Url(random(48));
  const redirect = new URL(CLOUDFLARE_OAUTH_REDIRECT);
  const authorizeUrl = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_ENDPOINT);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect.toString(),
    response_type: "code",
    scope: CLOUDFLARE_OAUTH_SCOPE_PROFILES[profile].join(" "),
    state,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
  }).toString();
  let settled = false;
  let settle: {
    resolve: (value: AuthorizationCode) => void;
    reject: (reason: Error) => void;
  } | undefined;
  const callback = new Promise<AuthorizationCode>((resolveCallback, rejectCallback) => {
    settle = { resolve: resolveCallback, reject: rejectCallback };
  });
  // The browser launcher may synchronously exercise the callback in tests or
  // embedded hosts. Attach a rejection observer before yielding to it.
  void callback.catch(() => undefined);
  const server = createServer((request, response) => {
    if (settled) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" }).end("This Cloudflare authorization callback was already used.");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", redirect);
    if (requestUrl.pathname !== redirect.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    settled = true;
    if (requestUrl.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("ArtifactPass rejected an OAuth state mismatch.");
      settle?.reject(new Error("Cloudflare OAuth returned a state mismatch"));
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    if (oauthError !== null || code === null || code.length === 0 || code.length > 4096) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Cloudflare authorization was not completed.");
      settle?.reject(new Error(oauthError === null
        ? "Cloudflare authorization did not return a code"
        : `Cloudflare authorization was refused (${oauthError})`));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }).end("Cloudflare authorization received. Return to the ArtifactPass terminal.");
    settle?.resolve({ code, verifier });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(Number(redirect.port), redirect.hostname, resolveListen);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await dependencies.openBrowser(authorizeUrl.toString());
    } catch {
      dependencies.onManualOpen?.(authorizeUrl.toString());
    }
    const authorizationCode = await Promise.race([
      callback,
      new Promise<never>((_resolve, rejectTimeout) => {
        timeout = setTimeout(
          () => rejectTimeout(new Error("Cloudflare authorization timed out. Run the resume command to try again.")),
          dependencies.timeoutMilliseconds ?? 5 * 60_000,
        );
      }),
    ]);
    const token = await postTokenForm(CLOUDFLARE_OAUTH_TOKEN_ENDPOINT, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode.code,
      code_verifier: authorizationCode.verifier,
      redirect_uri: redirect.toString(),
    }, dependencies.fetch ?? globalThis.fetch);
    return {
      profile,
      token,
      grantedScopes: assertExactCloudflareOAuthScopes(profile, token.scope),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await closeServer(server);
  }
};
