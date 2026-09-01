#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REGISTERED_LOOPBACK_REDIRECT = "http://127.0.0.1:8976/oauth/callback";

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

const protocolScopes = new Set(["offline_access", "openid"]);

export const OAUTH_SCOPE_PROFILES = Object.freeze({
  companyLogin: commonScopes,
  emailCode: Object.freeze([...commonScopes, "access-idp.write", "offline_access"]),
});

export const REQUIRED_OPERATIONS = Object.freeze([
  "oauth.company_login.authorization_code_pkce",
  "oauth.company_login.exact_scopes",
  "oauth.company_login.rejects_idp_write",
  "oauth.company_login.revoke",
  "oauth.email_code.authorization_code_pkce",
  "oauth.email_code.exact_scopes",
  "oauth.email_code.refresh",
  "oauth.email_code.revoke",
  "cloudflare.account_binding",
  "cloudflare.zone_binding",
  "cloudflare.scope_catalog",
  "wrangler.d1_migration",
  "wrangler.r2_lifecycle",
  "wrangler.r2_object_put",
  "wrangler.r2_object_get",
  "wrangler.r2_object_delete",
  "wrangler.secret_bulk",
  "wrangler.worker_deploy",
  "wrangler.worker_readiness",
  "wrangler.worker_rollback",
  "cloudflare.worker_route_create_delete",
  "cloudflare.access_organization_read",
  "cloudflare.access_identity_providers_read",
  "cloudflare.access_otp_create",
  "cloudflare.access_otp_delete",
  "cloudflare.access_application_create",
  "cloudflare.access_application_delete",
  "cloudflare.access_policy_create",
  "cloudflare.access_policy_delete",
  "cloudflare.disposable_resource_cleanup",
  "oauth.loopback_fixed_port",
  "oauth.loopback_dynamic_port_rejected",
]);

const redactedKey = /(?:^|_)(?:access[_-]?token|refresh[_-]?token|authorization[_-]?code|client[_-]?secret|code[_-]?verifier|secret|token)(?:$|_)/iu;

export const redactQualificationValue = (value, key = "") => {
  if (redactedKey.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((entry) => redactQualificationValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactQualificationValue(entryValue, entryKey),
    ]));
  }
  return value;
};

const scopeId = (entry) => {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return undefined;
  for (const key of ["scope", "id", "name"]) {
    if (typeof entry[key] === "string") return entry[key];
  }
  return undefined;
};

export const validateScopeCatalog = (catalog) => {
  const catalogIds = new Set(catalog.map(scopeId).filter((value) => value !== undefined));
  const requested = OAUTH_SCOPE_PROFILES.emailCode.filter((scope) => !protocolScopes.has(scope));
  return {
    available: requested.filter((scope) => catalogIds.has(scope)),
    missing: requested.filter((scope) => !catalogIds.has(scope)),
  };
};

export const assertLoopbackRedirect = (value) => {
  const redirect = new URL(value);
  if (redirect.toString() !== REGISTERED_LOOPBACK_REDIRECT) {
    throw new Error(`OAuth must use the registered loopback callback ${REGISTERED_LOOPBACK_REDIRECT}`);
  }
  return redirect.toString();
};

export const buildQualificationRecord = ({
  environment,
  clientId,
  accountAlias,
  zoneAlias,
  profile,
  scopeCatalog,
  operations,
  requiredOperations = REQUIRED_OPERATIONS,
  startedAt,
  completedAt,
}) => {
  const operationByName = new Map(operations.map((operation) => [operation.name, operation]));
  const failedRequiredOperations = requiredOperations.filter((name) => operationByName.get(name)?.status !== "passed");
  const catalog = validateScopeCatalog(scopeCatalog);
  const decision = failedRequiredOperations.length === 0 && catalog.missing.length === 0 ? "go" : "no-go";
  return redactQualificationValue({
    schema_version: 1,
    decision,
    environment,
    client_id_sha256: createHash("sha256").update(clientId).digest("hex"),
    account_alias: accountAlias,
    zone_alias: zoneAlias,
    profile,
    registered_redirect: REGISTERED_LOOPBACK_REDIRECT,
    frozen_scope_profiles: OAUTH_SCOPE_PROFILES,
    scope_catalog: catalog,
    required_operations: requiredOperations,
    failed_required_operations: failedRequiredOperations,
    operations,
    started_at: startedAt,
    completed_at: completedAt,
  });
};

const parseArguments = (arguments_) => {
  const parsed = {
    clientId: process.env.CLOUDFLARE_OAUTH_CLIENT_ID,
    accountName: process.env.CLOUDFLARE_ACCOUNT_NAME,
    zoneName: process.env.CLOUDFLARE_ZONE_NAME ?? "artifactpass.com",
    recordPath: process.env.CLOUDFLARE_OAUTH_QUALIFICATION_RECORD ??
      resolve(repositoryRoot, "docs/releases/2026-09-01-cloudflare-oauth-qualification.json"),
    openBrowser: true,
    contractOnly: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--no-open") parsed.openBrowser = false;
    else if (argument === "--contract-only") parsed.contractOnly = true;
    else if (["--client-id", "--account-name", "--zone-name", "--record"].includes(argument)) {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--client-id") parsed.clientId = value;
      if (argument === "--account-name") parsed.accountName = value;
      if (argument === "--zone-name") parsed.zoneName = value;
      if (argument === "--record") parsed.recordPath = resolve(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
};

const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256Base64Url = (value) => base64Url(createHash("sha256").update(value).digest());

const openExternal = (url) => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, arguments_, { detached: true, stdio: "ignore" });
  child.unref();
};

const waitForAuthorizationCode = async ({ clientId, scopes, openBrowser }) => {
  const redirect = new URL(assertLoopbackRedirect(REGISTERED_LOOPBACK_REDIRECT));
  const state = base64Url(randomBytes(24));
  const verifier = base64Url(randomBytes(48));
  const authorizeUrl = new URL("https://dash.cloudflare.com/oauth2/auth");
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect.toString(),
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
  }).toString();

  let settle;
  const result = new Promise((resolveResult, rejectResult) => { settle = { resolveResult, rejectResult }; });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", redirect);
    if (requestUrl.pathname !== redirect.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (requestUrl.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("ArtifactPass rejected an OAuth state mismatch.");
      settle.rejectResult(new Error("Cloudflare OAuth returned a state mismatch"));
      return;
    }
    const error = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    if (error !== null || code === null) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Cloudflare authorization was not completed.");
      settle.rejectResult(new Error(`Cloudflare authorization failed${error === null ? "" : ` (${error})`}`));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Cloudflare authorization received. Return to the ArtifactPass terminal.");
    settle.resolveResult({ code, verifier });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(Number(redirect.port), redirect.hostname, resolveListen);
  });
  process.stdout.write(`Authorize ArtifactPass in Cloudflare:\n${authorizeUrl}\n`);
  if (openBrowser) openExternal(authorizeUrl.toString());
  let timeout;
  try {
    return await Promise.race([
      result,
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error("Cloudflare OAuth callback timed out after five minutes")), 300_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await new Promise((resolveClose) => server.close(resolveClose));
  }
};

const tokenRequest = async (parameters) => {
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null || typeof body.access_token !== "string") {
    throw new Error(`Cloudflare OAuth token exchange failed (${response.status})`);
  }
  return body;
};

const authorizeProfile = async ({ clientId, profile, openBrowser }) => {
  const redirectUri = assertLoopbackRedirect(REGISTERED_LOOPBACK_REDIRECT);
  const { code, verifier } = await waitForAuthorizationCode({
    clientId,
    scopes: OAUTH_SCOPE_PROFILES[profile],
    openBrowser,
  });
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
};

const refreshAccessToken = (clientId, refreshToken) => tokenRequest({
  grant_type: "refresh_token",
  client_id: clientId,
  refresh_token: refreshToken,
});

const revokeToken = async (clientId, token) => {
  const response = await fetch("https://dash.cloudflare.com/oauth2/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cloudflare OAuth token revocation failed (${response.status})`);
};

const revokeAuthorization = async (clientId, tokenResponses) => {
  const accessTokens = [...new Set(tokenResponses.map((response) => response?.access_token).filter(Boolean))];
  const refreshTokens = [...new Set(tokenResponses.map((response) => response?.refresh_token).filter(Boolean))];
  for (const accessToken of accessTokens) {
    await revokeToken(clientId, accessToken);
    try {
      await apiRequest(accessToken, "/user");
      throw new Error("Cloudflare OAuth access token remained active after revocation");
    } catch (error) {
      if (!(error instanceof CloudflareQualificationError) || ![401, 403].includes(error.status)) throw error;
    }
  }
  for (const refreshToken of refreshTokens) await revokeToken(clientId, refreshToken);
  return { revoked_access_tokens: accessTokens.length, revoked_refresh_tokens: refreshTokens.length };
};

class CloudflareQualificationError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const apiRequest = async (token, path, init = {}) => {
  const response = await fetch(new URL(path.replace(/^\//u, ""), "https://api.cloudflare.com/client/v4/"), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await response.json().catch(() => null);
  if (!response.ok || envelope?.success !== true) {
    const firstError = envelope?.errors?.[0];
    throw new CloudflareQualificationError(
      firstError?.message ?? `Cloudflare API request failed (${response.status})`,
      response.status,
      firstError?.code,
    );
  }
  return envelope.result;
};

const grantedScopes = (tokenResponse) => {
  const scopes = typeof tokenResponse.scope === "string"
    ? tokenResponse.scope.split(/\s+/u).filter(Boolean)
    : Array.isArray(tokenResponse.scopes) ? tokenResponse.scopes : [];
  return [...new Set(scopes)].sort();
};

const recordOperation = async (operations, name, action) => {
  const startedAt = new Date().toISOString();
  try {
    const detail = await action();
    operations.push(redactQualificationValue({ name, status: "passed", started_at: startedAt, completed_at: new Date().toISOString(), detail }));
    return detail;
  } catch (error) {
    operations.push(redactQualificationValue({
      name,
      status: "failed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      detail: error instanceof Error ? error.message : String(error),
      ...(typeof error?.status === "number" ? { http_status: error.status } : {}),
      ...(typeof error?.code === "number" ? { cloudflare_code: error.code } : {}),
    }));
    throw error;
  }
};

const assertExactScopes = (profile, tokenResponse) => {
  const expected = [...OAUTH_SCOPE_PROFILES[profile]].sort();
  const actual = grantedScopes(tokenResponse);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Cloudflare granted ${actual.join(", ") || "no reported scopes"}; expected ${expected.join(", ")}`);
  }
  return actual;
};

const runWrangler = async (token, accountId, arguments_, options = {}) => {
  const result = await execute(
    "pnpm",
    ["--dir", "packages/setup-cli", "exec", "wrangler", ...arguments_],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: token,
      },
      input: options.input,
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
    },
  );
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

const writeQualificationFixture = async ({ root, name, databaseId }) => {
  const migrations = resolve(root, "migrations");
  await mkdir(migrations, { recursive: true });
  const workerPath = resolve(root, "worker.mjs");
  const configPath = resolve(root, "wrangler.jsonc");
  const lifecyclePath = resolve(root, "lifecycle.json");
  const secretsPath = resolve(root, "secrets.json");
  const sentinelPath = resolve(root, "sentinel.json");
  await writeFile(workerPath, `export default { async fetch(request, env) {\n  const url = new URL(request.url);\n  if (url.pathname === "/health") return Response.json({ status: "ok", secret: env.QUALIFICATION_SECRET === "present" });\n  return new Response("ArtifactPass OAuth qualification");\n} };\n`, { mode: 0o600 });
  await writeFile(resolve(migrations, "0001_qualification.sql"), "CREATE TABLE IF NOT EXISTS qualification (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL);\n", { mode: 0o600 });
  await writeFile(lifecyclePath, `${JSON.stringify({ rules: [{
    id: "delete-qualification-objects",
    enabled: true,
    conditions: { prefix: ".artifactpass/" },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
  }] }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(secretsPath, `${JSON.stringify({ QUALIFICATION_SECRET: "present" })}\n`, { mode: 0o600 });
  await writeFile(sentinelPath, `${JSON.stringify({ qualification: true, name })}\n`, { mode: 0o600 });
  await writeFile(configPath, `${JSON.stringify({
    name,
    main: workerPath,
    compatibility_date: "2026-08-31",
    workers_dev: true,
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: name, database_id: databaseId, migrations_dir: migrations }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: name }],
  }, null, 2)}\n`, { mode: 0o600 });
  return { configPath, lifecyclePath, secretsPath, sentinelPath, workerPath };
};

const waitForWorker = async (url) => {
  let lastStatus = 0;
  for (const delay of [0, 500, 1_000, 2_000, 4_000, 8_000]) {
    if (delay > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delay));
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      lastStatus = response.status;
      const body = await response.json().catch(() => null);
      if (response.ok && body?.status === "ok" && body.secret === true) return { status: response.status };
    } catch {
      // Propagation is expected to take a few seconds.
    }
  }
  throw new Error(`Qualification Worker did not become ready (last status ${lastStatus})`);
};

const selectAccountAndZone = async (token, accountName, zoneName) => {
  const accounts = await apiRequest(token, "/accounts?per_page=50");
  const accountCandidates = Array.isArray(accounts) ? accounts : [];
  const account = accountName === undefined
    ? accountCandidates.length === 1 ? accountCandidates[0] : undefined
    : accountCandidates.find((candidate) => candidate.name === accountName);
  if (account === undefined) {
    throw new Error(accountName === undefined
      ? "Specify --account-name because Cloudflare returned more than one account"
      : `Cloudflare account ${accountName} is unavailable`);
  }
  const zones = await apiRequest(token, `/zones?account.id=${encodeURIComponent(account.id)}&name=${encodeURIComponent(zoneName)}&per_page=50`);
  const zone = Array.isArray(zones) ? zones.find((candidate) => candidate.name === zoneName && candidate.status === "active") : undefined;
  if (zone === undefined) throw new Error(`Active Cloudflare zone ${zoneName} is unavailable in ${account.name}`);
  return { account, zone };
};

const runCompanyLoginProfile = async ({ clientId, openBrowser, operations }) => {
  const tokenResponse = await recordOperation(operations, "oauth.company_login.authorization_code_pkce", () =>
    authorizeProfile({ clientId, profile: "companyLogin", openBrowser }));
  try {
    await recordOperation(operations, "oauth.company_login.exact_scopes", () => assertExactScopes("companyLogin", tokenResponse));
    await recordOperation(operations, "oauth.company_login.rejects_idp_write", async () => {
      const memberships = await apiRequest(tokenResponse.access_token, "/memberships?per_page=1");
      const accountId = Array.isArray(memberships) ? memberships[0]?.account?.id : undefined;
      if (typeof accountId !== "string") throw new Error("Could not resolve an account for the negative IdP write probe");
      try {
        const created = await apiRequest(tokenResponse.access_token, `/accounts/${accountId}/access/identity_providers`, {
          method: "POST",
          body: JSON.stringify({ name: "ArtifactPass qualification must not create", type: "onetimepin", config: {} }),
        });
        if (typeof created?.id === "string") {
          await apiRequest(tokenResponse.access_token, `/accounts/${accountId}/access/identity_providers/${created.id}`, { method: "DELETE" }).catch(() => undefined);
        }
        throw new Error("Company-login profile unexpectedly allowed identity-provider write");
      } catch (error) {
        if (error instanceof CloudflareQualificationError && [401, 403].includes(error.status)) {
          return { rejected_status: error.status };
        }
        throw error;
      }
    });
  } finally {
    await recordOperation(operations, "oauth.company_login.revoke", async () => {
      return revokeAuthorization(clientId, [tokenResponse]);
    });
  }
};

const runEmailCodeProfile = async ({ clientId, openBrowser, accountName, zoneName, operations }) => {
  let initialToken;
  let refreshedToken;
  let token;
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifactpass-oauth-qualification-"));
  const suffix = randomBytes(4).toString("hex");
  const resourceName = `artifactpass-oauth-qualification-${suffix}`;
  const routeHostname = `${resourceName}.${zoneName}`;
  let account;
  let zone;
  let database;
  let bucketCreated = false;
  let route;
  let accessApplication;
  let accessPolicy;
  let otpProvider;
  let workerCreated = false;
  let files;
  try {
    initialToken = await recordOperation(operations, "oauth.email_code.authorization_code_pkce", () =>
      authorizeProfile({ clientId, profile: "emailCode", openBrowser }));
    await recordOperation(operations, "oauth.email_code.exact_scopes", () => assertExactScopes("emailCode", initialToken));
    if (typeof initialToken.refresh_token !== "string") throw new Error("Cloudflare did not issue a refresh token to the public OAuth client");
    refreshedToken = await recordOperation(operations, "oauth.email_code.refresh", () =>
      refreshAccessToken(clientId, initialToken.refresh_token));
    token = refreshedToken.access_token;
    ({ account, zone } = await recordOperation(operations, "cloudflare.account_binding", async () => {
      const selection = await selectAccountAndZone(token, accountName, zoneName);
      return selection;
    }));
    operations[operations.length - 1].detail = { account_alias: account.name };
    await recordOperation(operations, "cloudflare.zone_binding", async () => ({ zone_alias: zone.name, status: zone.status }));
    const scopeEnvelope = await recordOperation(operations, "cloudflare.scope_catalog", () => apiRequest(token, "/oauth/scopes"));
    const scopeCatalog = Array.isArray(scopeEnvelope) ? scopeEnvelope : scopeEnvelope?.scopes ?? scopeEnvelope?.result ?? [];
    const catalogValidation = validateScopeCatalog(scopeCatalog);
    operations[operations.length - 1].detail = catalogValidation;
    if (catalogValidation.missing.length > 0) throw new Error(`Cloudflare scope catalog is missing ${catalogValidation.missing.join(", ")}`);

    await recordOperation(operations, "cloudflare.access_organization_read", () =>
      apiRequest(token, `/accounts/${account.id}/access/organizations`).then((organization) => ({ configured: typeof organization?.auth_domain === "string" })));
    await recordOperation(operations, "cloudflare.access_identity_providers_read", () =>
      apiRequest(token, `/accounts/${account.id}/access/identity_providers`).then((providers) => ({ count: Array.isArray(providers) ? providers.length : 0 })));

    database = await apiRequest(token, `/accounts/${account.id}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: resourceName }),
    });
    await apiRequest(token, `/accounts/${account.id}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: resourceName }),
    });
    bucketCreated = true;
    files = await writeQualificationFixture({ root: temporaryRoot, name: resourceName, databaseId: database.uuid });

    await recordOperation(operations, "wrangler.d1_migration", () => runWrangler(token, account.id, [
      "d1", "migrations", "apply", resourceName, "--remote", "--config", files.configPath,
    ]).then(() => ({ applied: true })));
    await recordOperation(operations, "wrangler.r2_lifecycle", () => runWrangler(token, account.id, [
      "r2", "bucket", "lifecycle", "set", resourceName, "--file", files.lifecyclePath, "--force",
    ]).then(() => ({ applied: true })));
    const objectPath = `${resourceName}/.artifactpass/deployment.json`;
    const downloadedSentinel = resolve(temporaryRoot, "sentinel-downloaded.json");
    await recordOperation(operations, "wrangler.r2_object_put", () => runWrangler(token, account.id, [
      "r2", "object", "put", objectPath, "--remote", "--file", files.sentinelPath,
    ]).then(() => ({ object_alias: ".artifactpass/deployment.json" })));
    await recordOperation(operations, "wrangler.r2_object_get", async () => {
      await runWrangler(token, account.id, ["r2", "object", "get", objectPath, "--remote", "--file", downloadedSentinel]);
      const [expected, actual] = await Promise.all([readFile(files.sentinelPath), readFile(downloadedSentinel)]);
      if (!expected.equals(actual)) throw new Error("R2 ownership sentinel bytes changed");
      return { exact_bytes: true };
    });
    await recordOperation(operations, "wrangler.r2_object_delete", () => runWrangler(token, account.id, [
      "r2", "object", "delete", objectPath, "--remote",
    ]).then(() => ({ deleted: true })));
    await recordOperation(operations, "wrangler.secret_bulk", () => runWrangler(token, account.id, [
      "secret", "bulk", files.secretsPath, "--config", files.configPath,
    ]).then(() => {
      workerCreated = true;
      return { written: true };
    }));
    await recordOperation(operations, "wrangler.worker_deploy", async () => {
      await runWrangler(token, account.id, ["deploy", "--config", files.configPath, "--strict"]);
      workerCreated = true;
      return { worker_alias: resourceName };
    });
    const subdomain = await apiRequest(token, `/accounts/${account.id}/workers/subdomain`);
    await recordOperation(operations, "wrangler.worker_readiness", () =>
      waitForWorker(`https://${resourceName}.${subdomain.subdomain}.workers.dev/health`));
    await recordOperation(operations, "cloudflare.worker_route_create_delete", async () => {
      route = await apiRequest(token, `/zones/${zone.id}/workers/routes`, {
        method: "POST",
        body: JSON.stringify({ pattern: `${routeHostname}/*`, script: resourceName }),
      });
      await apiRequest(token, `/zones/${zone.id}/workers/routes/${route.id}`, { method: "DELETE" });
      route = undefined;
      return { route_alias: `${routeHostname}/*`, deleted: true };
    });

    otpProvider = await recordOperation(operations, "cloudflare.access_otp_create", () =>
      apiRequest(token, `/accounts/${account.id}/access/identity_providers`, {
        method: "POST",
        body: JSON.stringify({ name: `ArtifactPass OAuth qualification ${suffix}`, type: "onetimepin", config: {} }),
      }));
    operations[operations.length - 1].detail = { provider_type: "onetimepin", created: true };
    accessApplication = await recordOperation(operations, "cloudflare.access_application_create", () =>
      apiRequest(token, `/accounts/${account.id}/access/apps`, {
        method: "POST",
        body: JSON.stringify({
          name: resourceName,
          type: "self_hosted",
          session_duration: "15m",
          destinations: [{ type: "public", uri: `${routeHostname}/upload*` }],
          allowed_idps: [otpProvider.id],
          auto_redirect_to_identity: true,
        }),
      }));
    operations[operations.length - 1].detail = { created: true, application_alias: resourceName };
    accessPolicy = await recordOperation(operations, "cloudflare.access_policy_create", () =>
      apiRequest(token, `/accounts/${account.id}/access/apps/${accessApplication.id}/policies`, {
        method: "POST",
        body: JSON.stringify({ name: "ArtifactPass qualification", decision: "allow", include: [{ email_domain: { domain: zone.name } }] }),
      }));
    operations[operations.length - 1].detail = { created: typeof accessPolicy?.id === "string" };

    await writeFile(files.workerPath, `export default { async fetch() { return Response.json({ status: "rollback-candidate" }); } };\n`, { mode: 0o600 });
    await runWrangler(token, account.id, ["deploy", "--config", files.configPath, "--strict"]);
    await writeQualificationFixture({ root: temporaryRoot, name: resourceName, databaseId: database.uuid });
    await recordOperation(operations, "wrangler.worker_rollback", async () => {
      await runWrangler(token, account.id, ["deploy", "--config", files.configPath, "--strict"]);
      return waitForWorker(`https://${resourceName}.${subdomain.subdomain}.workers.dev/health`);
    });
  } finally {
    if (account !== undefined && token !== undefined) {
      if (accessPolicy?.id !== undefined && accessApplication?.id !== undefined) {
        await recordOperation(operations, "cloudflare.access_policy_delete", () =>
          apiRequest(token, `/accounts/${account.id}/access/apps/${accessApplication.id}/policies/${accessPolicy.id}`, { method: "DELETE" })
            .then(() => ({ deleted: true }))).catch(() => undefined);
        accessPolicy = undefined;
      }
      if (accessApplication?.id !== undefined) {
        await recordOperation(operations, "cloudflare.access_application_delete", () =>
          apiRequest(token, `/accounts/${account.id}/access/apps/${accessApplication.id}`, { method: "DELETE" })
            .then(() => ({ deleted: true }))).catch(() => undefined);
        accessApplication = undefined;
      }
      if (otpProvider?.id !== undefined) {
        await recordOperation(operations, "cloudflare.access_otp_delete", () =>
          apiRequest(token, `/accounts/${account.id}/access/identity_providers/${otpProvider.id}`, { method: "DELETE" })
            .then(() => ({ deleted: true }))).catch(() => undefined);
        otpProvider = undefined;
      }
      await recordOperation(operations, "cloudflare.disposable_resource_cleanup", async () => {
        const failures = [];
        const cleanup = async (name, action) => {
          try {
            await action();
          } catch (error) {
            failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        if (route?.id !== undefined && zone !== undefined) {
          await cleanup("Worker route", () => apiRequest(token, `/zones/${zone.id}/workers/routes/${route.id}`, { method: "DELETE" }));
        }
        if (workerCreated) {
          await cleanup("Worker", () => apiRequest(token, `/accounts/${account.id}/workers/scripts/${resourceName}`, { method: "DELETE" }));
        }
        if (bucketCreated) {
          await cleanup("R2 bucket", () => apiRequest(token, `/accounts/${account.id}/r2/buckets/${resourceName}`, { method: "DELETE" }));
        }
        if (database?.uuid !== undefined) {
          await cleanup("D1 database", () => apiRequest(token, `/accounts/${account.id}/d1/database/${database.uuid}`, { method: "DELETE" }));
        }
        if (failures.length > 0) throw new AggregateError(failures.map((message) => new Error(message)), "Disposable Cloudflare cleanup was incomplete");
        return {
          route_deleted: route?.id !== undefined,
          worker_deleted: workerCreated,
          bucket_deleted: bucketCreated,
          database_deleted: database?.uuid !== undefined,
        };
      }).catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    if (initialToken !== undefined) {
      await recordOperation(operations, "oauth.email_code.revoke", () =>
        revokeAuthorization(clientId, [initialToken, refreshedToken])).catch(() => undefined);
    }
  }
  return { accountAlias: account?.name, zoneAlias: zone?.name };
};

const writeRecord = async (path, record) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(redactQualificationValue(record), null, 2)}\n`, { mode: 0o600 });
};

export const main = async (arguments_ = process.argv.slice(2)) => {
  const input = parseArguments(arguments_);
  if (input.contractOnly) {
    process.stdout.write(`${JSON.stringify({ redirect: REGISTERED_LOOPBACK_REDIRECT, profiles: OAUTH_SCOPE_PROFILES }, null, 2)}\n`);
    return;
  }
  if (typeof input.clientId !== "string" || input.clientId.length === 0) {
    throw new Error("Provide the staging public OAuth client ID with --client-id or CLOUDFLARE_OAUTH_CLIENT_ID");
  }
  const startedAt = new Date().toISOString();
  const operations = [];
  let accountAlias = input.accountName ?? "unresolved";
  let zoneAlias = input.zoneName;
  let scopeCatalog = [];
  try {
    await recordOperation(operations, "oauth.loopback_fixed_port", async () => ({ redirect: assertLoopbackRedirect(REGISTERED_LOOPBACK_REDIRECT) }));
    await recordOperation(operations, "oauth.loopback_dynamic_port_rejected", async () => {
      try {
        assertLoopbackRedirect("http://127.0.0.1:0/oauth/callback");
      } catch {
        return { rejected: true };
      }
      throw new Error("A dynamic loopback port was unexpectedly accepted");
    });
    await runCompanyLoginProfile({ clientId: input.clientId, openBrowser: input.openBrowser, operations });
    const selection = await runEmailCodeProfile({
      clientId: input.clientId,
      openBrowser: input.openBrowser,
      accountName: input.accountName,
      zoneName: input.zoneName,
      operations,
    });
    accountAlias = selection.accountAlias ?? accountAlias;
    zoneAlias = selection.zoneAlias ?? zoneAlias;
    const catalogOperation = operations.find((operation) => operation.name === "cloudflare.scope_catalog");
    scopeCatalog = catalogOperation?.status === "passed"
      ? OAUTH_SCOPE_PROFILES.emailCode.map((scope) => ({ scope }))
      : [];
  } catch (error) {
    process.stderr.write(`OAuth qualification stopped: ${redactQualificationValue(error instanceof Error ? error.message : String(error))}\n`);
  }
  const record = buildQualificationRecord({
    environment: "staging",
    clientId: input.clientId,
    accountAlias,
    zoneAlias,
    profile: "companyLogin+emailCode",
    scopeCatalog,
    operations,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  await writeRecord(input.recordPath, record);
  process.stdout.write(`Cloudflare OAuth qualification: ${record.decision}\nRecord: ${input.recordPath}\n`);
  if (record.decision !== "go") process.exitCode = 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
