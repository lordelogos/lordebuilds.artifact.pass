import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OAUTH_SCOPE_PROFILES,
  assertLoopbackRedirect,
  buildQualificationRecord,
  redactQualificationValue,
  validateScopeCatalog,
} from "./qualify-cloudflare-oauth.mjs";

const commonScopes = [
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
];

test("freezes separate company-login and email-code scope profiles", () => {
  assert.deepEqual(OAUTH_SCOPE_PROFILES.companyLogin, commonScopes);
  assert.deepEqual(OAUTH_SCOPE_PROFILES.emailCode, [...commonScopes, "access-idp.write", "offline_access"]);
  assert.equal(OAUTH_SCOPE_PROFILES.companyLogin.includes("access-idp.write"), false);
  assert.equal(OAUTH_SCOPE_PROFILES.companyLogin.includes("offline_access"), false);
  assert.equal(OAUTH_SCOPE_PROFILES.emailCode.includes("access-group.write"), false);
});

test("matches the frozen profiles against Cloudflare's live scope catalog shape", () => {
  const resourceScopes = OAUTH_SCOPE_PROFILES.emailCode.filter((scope) => scope !== "offline_access");
  const catalog = resourceScopes.map((scope) => ({ scope }));
  assert.deepEqual(validateScopeCatalog(catalog), {
    available: resourceScopes,
    missing: [],
  });
  assert.deepEqual(validateScopeCatalog(catalog.filter(({ scope }) => scope !== "d1.write")).missing, ["d1.write"]);
});

test("accepts only the registered fixed loopback callback", () => {
  assert.equal(
    assertLoopbackRedirect("http://127.0.0.1:8976/oauth/callback"),
    "http://127.0.0.1:8976/oauth/callback",
  );
  assert.throws(
    () => assertLoopbackRedirect("http://127.0.0.1:8977/oauth/callback"),
    /registered loopback callback/u,
  );
  assert.throws(
    () => assertLoopbackRedirect("http://localhost:8976/oauth/callback"),
    /registered loopback callback/u,
  );
});

test("redacts credentials, authorization codes, and secret-bearing output recursively", () => {
  assert.deepEqual(redactQualificationValue({
    access_token: "live-access",
    nested: {
      refreshToken: "live-refresh",
      authorization_code: "live-code",
      client_secret: "live-secret",
      safe: "kept",
    },
    command: "wrangler deploy",
  }), {
    access_token: "[redacted]",
    nested: {
      refreshToken: "[redacted]",
      authorization_code: "[redacted]",
      client_secret: "[redacted]",
      safe: "kept",
    },
    command: "wrangler deploy",
  });
});

test("a missing required operation forces a no-go qualification record", () => {
  const record = buildQualificationRecord({
    environment: "staging",
    clientId: "example-client",
    accountAlias: "Example account",
    zoneAlias: "example.com",
    profile: "emailCode",
    scopeCatalog: OAUTH_SCOPE_PROFILES.emailCode.map((scope) => ({ scope })),
    operations: [
      { name: "oauth.authorization_code_pkce", status: "passed" },
      { name: "wrangler.deploy", status: "failed", detail: "permission denied" },
    ],
    requiredOperations: ["oauth.authorization_code_pkce", "wrangler.deploy"],
    startedAt: "2026-09-01T12:00:00.000Z",
    completedAt: "2026-09-01T12:01:00.000Z",
  });
  assert.equal(record.decision, "no-go");
  assert.deepEqual(record.failed_required_operations, ["wrangler.deploy"]);
  assert.equal(JSON.stringify(record).includes("example-client"), false);
});
