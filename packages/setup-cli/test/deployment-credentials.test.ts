import { describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "agent-bridge";

import { CLOUDFLARE_OAUTH_SCOPE_PROFILES, type CloudflareOAuthAuthorization } from "../src/cloudflare/oauth";
import {
  DeploymentCredentialManager,
  createEphemeralDeploymentCredentialSession,
} from "../src/private-deployment/deployment-credentials";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const client = { environment: "staging" as const, clientId: "a".repeat(32) };
const now = new Date("2026-09-01T17:00:00.000Z");

const authorization = (expiresIn = 3600): CloudflareOAuthAuthorization => ({
  profile: "companyLogin",
  grantedScopes: CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin,
  token: {
    access_token: `access-${"x".repeat(32)}`,
    refresh_token: `refresh-${"x".repeat(32)}`,
    expires_in: expiresIn,
    scope: CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin.join(" "),
    token_type: "bearer",
  },
});

const memoryStore = (): CredentialStore & { value: string | null } => ({
  value: null,
  async get() { return this.value; },
  async set(value) { this.value = value; },
  async delete() { this.value = null; },
});

describe("private deployment credentials", () => {
  it("stores the bound grant only in the credential store and reports no secret", async () => {
    const store = memoryStore();
    const manager = new DeploymentCredentialManager({ deploymentId, client, store, now: () => now });
    await manager.save(authorization());
    expect(store.value).toContain("access-");
    const status = await manager.status();
    expect(status).toEqual({
      connected: true,
      client_environment: "staging",
      profile: "companyLogin",
      granted_scopes: [...CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin].sort(),
      expires_at: "2026-09-01T18:00:00.000Z",
      refresh_available: true,
    });
    expect(JSON.stringify(status)).not.toContain(authorization().token.access_token);
    expect(JSON.stringify(status)).not.toContain(authorization().token.refresh_token as string);
  });

  it("refreshes near expiry and persists the rotated credential", async () => {
    const store = memoryStore();
    const fetchImplementation = vi.fn(async () => Response.json({
      ...authorization().token,
      access_token: `rotated-${"y".repeat(32)}`,
      refresh_token: `rotated-refresh-${"y".repeat(32)}`,
    }));
    const manager = new DeploymentCredentialManager({ deploymentId, client, store, fetch: fetchImplementation, now: () => now });
    await manager.save(authorization(10));
    await expect(manager.resolveAccessToken()).resolves.toContain("rotated-");
    expect(store.value).toContain("rotated-refresh-");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("keeps non-secret deployment progress independent when refresh fails", async () => {
    const store = memoryStore();
    const manager = new DeploymentCredentialManager({
      deploymentId,
      client,
      store,
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      now: () => now,
    });
    await manager.save(authorization(10));
    await expect(manager.resolveAccessToken()).rejects.toThrow("resume this deployment to reconnect");
    expect(store.value).not.toBeNull();
  });

  it("rejects a credential bound to another deployment or OAuth client", async () => {
    const store = memoryStore();
    const original = new DeploymentCredentialManager({ deploymentId, client, store, now: () => now });
    await original.save(authorization());
    const wrongClient = new DeploymentCredentialManager({
      deploymentId,
      client: { environment: "staging", clientId: "b".repeat(32) },
      store,
    });
    await expect(wrongClient.status()).rejects.toThrow("another deployment");
  });

  it("always removes the local credential when revocation fails", async () => {
    const store = memoryStore();
    const manager = new DeploymentCredentialManager({
      deploymentId,
      client,
      store,
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      now: () => now,
    });
    await manager.save(authorization());
    await expect(manager.disconnect()).resolves.toEqual({ revoked: false, removed: true });
    expect(store.value).toBeNull();
  });

  it("removes a malformed local credential when disconnecting", async () => {
    const store = memoryStore();
    store.value = "not-json";
    const manager = new DeploymentCredentialManager({ deploymentId, client, store });

    await expect(manager.disconnect()).resolves.toEqual({ revoked: false, removed: true });
    expect(store.value).toBeNull();
  });

  it("keeps no-save authorization in memory and revokes it at close", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 200 }));
    const session = createEphemeralDeploymentCredentialSession(client, authorization(), {
      fetch: fetchImplementation,
      now: () => now,
    });
    await expect(session.resolveAccessToken()).resolves.toContain("access-");
    await session.close();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    await expect(session.resolveAccessToken()).rejects.toThrow("closed");
  });

  it("closes a no-save authorization even when revocation is incomplete", async () => {
    let attempts = 0;
    const fetchImplementation = vi.fn(async () => {
      attempts += 1;
      return new Response(null, { status: attempts === 1 ? 503 : 200 });
    });
    const session = createEphemeralDeploymentCredentialSession(client, authorization(), {
      fetch: fetchImplementation,
      now: () => now,
    });

    await expect(session.close()).rejects.toThrow();
    await expect(session.resolveAccessToken()).rejects.toThrow("closed");
    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.resolveAccessToken()).rejects.toThrow("closed");
  });
});
