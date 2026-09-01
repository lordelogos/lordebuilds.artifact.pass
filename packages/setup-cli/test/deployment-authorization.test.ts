import { describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "agent-bridge";

import { CLOUDFLARE_OAUTH_SCOPE_PROFILES } from "../src/cloudflare/oauth";
import { resolveCloudflareOAuthClientConfiguration } from "../src/cloudflare/oauth-client-config";
import { authorizePrivateDeployment } from "../src/private-deployment/deployment-authorization";
import type { PrivateDeploymentState } from "../src/private-deployment/deployment-state";

const deployment: PrivateDeploymentState = {
  schema_version: 1,
  deployment_id: "11111111-1111-4111-8111-111111111111",
  created_by_cli_version: "0.1.0-rc.12",
  last_written_by_cli_version: "0.1.0-rc.12",
  status: "incomplete",
  stage: "authorization-required",
  created_at: "2026-09-01T17:00:00.000Z",
  updated_at: "2026-09-01T17:00:00.000Z",
  registrar_authority_confirmed: true,
  sign_in_mode: "company-login",
  checkpoints: {},
};

const memoryStore = (): CredentialStore & { value: string | null } => ({
  value: null,
  async get() { return this.value; },
  async set(value) { this.value = value; },
  async delete() { this.value = null; },
});

const callbackFor = async (authorizationUrl: string): Promise<void> => {
  const authorize = new URL(authorizationUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri") as string);
  callback.searchParams.set("state", authorize.searchParams.get("state") as string);
  callback.searchParams.set("code", "qualified-code");
  await fetch(callback);
};

describe("private deployment authorization orchestration", () => {
  it("uses an environment-only custom token without requiring or storing an OAuth client", async () => {
    const token = `custom-${"x".repeat(40)}`;
    const store = memoryStore();
    const session = await authorizePrivateDeployment(deployment, false, {
      environment: { CLOUDFLARE_API_TOKEN: token },
      credentialStore: store,
      oauth: { openBrowser: vi.fn() },
    });
    expect(session).toMatchObject({ persisted: false, source: "api-token", profile: "companyLogin" });
    await expect(session.resolveAccessToken()).resolves.toBe(token);
    expect(store.value).toBeNull();
  });

  it("stores a normal OAuth grant and keeps the token out of the returned status surface", async () => {
    const store = memoryStore();
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/token")) {
        return Response.json({
          access_token: `access-${"x".repeat(32)}`,
          refresh_token: `refresh-${"x".repeat(32)}`,
          expires_in: 3600,
          scope: CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin.join(" "),
          token_type: "bearer",
        });
      }
      return new Response(null, { status: 200 });
    });
    const session = await authorizePrivateDeployment(deployment, false, {
      environment: {
        ARTIFACTPASS_CLOUDFLARE_OAUTH_ENVIRONMENT: "staging",
        ARTIFACTPASS_CLOUDFLARE_OAUTH_CLIENT_ID: "a".repeat(32),
      },
      credentialStore: store,
      fetch: fetchImplementation,
      oauth: { openBrowser: callbackFor, timeoutMilliseconds: 1_000 },
      now: () => new Date("2026-09-01T17:00:00.000Z"),
    });
    expect(session).toMatchObject({ persisted: true, source: "oauth", profile: "companyLogin" });
    expect(store.value).toContain("refresh-");
    await expect(session.resolveAccessToken()).resolves.toContain("access-");
  });

  it("revokes a no-save OAuth grant and leaves the credential store untouched", async () => {
    const store = memoryStore();
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/token")) {
        return Response.json({
          access_token: `access-${"x".repeat(32)}`,
          refresh_token: `refresh-${"x".repeat(32)}`,
          expires_in: 3600,
          scope: CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin.join(" "),
          token_type: "bearer",
        });
      }
      return new Response(null, { status: 200 });
    });
    const session = await authorizePrivateDeployment(deployment, true, {
      environment: { ARTIFACTPASS_CLOUDFLARE_OAUTH_CLIENT_ID: "a".repeat(32) },
      credentialStore: store,
      fetch: fetchImplementation,
      oauth: { openBrowser: callbackFor, timeoutMilliseconds: 1_000 },
    });
    expect(session.persisted).toBe(false);
    await session.close();
    expect(store.value).toBeNull();
    expect(fetchImplementation.mock.calls.filter(([input]) => String(input).endsWith("/revoke"))).toHaveLength(2);
  });

  it("fails closed for a stable production client until its packaged ID is published", () => {
    expect(() => resolveCloudflareOAuthClientConfiguration({
      ARTIFACTPASS_CLOUDFLARE_OAUTH_ENVIRONMENT: "production",
    })).toThrow("production ArtifactPass Cloudflare OAuth client is not published");
  });
});
