import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARE_OAUTH_SCOPE_PROFILES,
  assertExactCloudflareOAuthScopes,
  authorizeCloudflareOAuth,
  refreshCloudflareOAuthToken,
  revokeCloudflareOAuthToken,
  type CloudflareOAuthProfile,
} from "../src/cloudflare/oauth";

const clientId = "a".repeat(32);

const tokenResponse = (profile: CloudflareOAuthProfile, overrides: Record<string, unknown> = {}) => ({
  access_token: `access-${"x".repeat(32)}`,
  refresh_token: `refresh-${"x".repeat(32)}`,
  expires_in: 3600,
  scope: CLOUDFLARE_OAUTH_SCOPE_PROFILES[profile].join(" "),
  token_type: "bearer",
  ...overrides,
});

const completeAuthorization = async (urlValue: string, parameters: Record<string, string>): Promise<Response> => {
  const authorizeUrl = new URL(urlValue);
  const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") as string);
  for (const [name, value] of Object.entries(parameters)) callback.searchParams.set(name, value);
  return fetch(callback);
};

describe("Cloudflare OAuth", () => {
  it("freezes the qualified least-privilege profiles", () => {
    expect(CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin).toEqual([
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
    expect(CLOUDFLARE_OAUTH_SCOPE_PROFILES.emailCode).toEqual([
      ...CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin,
      "access-idp.write",
      "offline_access",
    ]);
    expect(CLOUDFLARE_OAUTH_SCOPE_PROFILES.companyLogin).not.toContain("access-idp.write");
    expect(CLOUDFLARE_OAUTH_SCOPE_PROFILES.emailCode).not.toContain("access-groups.write");
  });

  it("completes a flow-bound PKCE authorization and verifies exact scopes", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("qualified-code");
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/u);
      return Response.json(tokenResponse("emailCode"));
    });
    const result = await authorizeCloudflareOAuth(clientId, "emailCode", {
      fetch: fetchImplementation,
      randomBytes: (size) => Buffer.alloc(size, 7),
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state") as string;
        expect((await completeAuthorization(url, { state, code: "qualified-code" })).status).toBe(200);
      },
      timeoutMilliseconds: 1_000,
    });
    expect(result.profile).toBe("emailCode");
    expect(result.grantedScopes).toEqual([...CLOUDFLARE_OAUTH_SCOPE_PROFILES.emailCode].sort());
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("rejects mismatched state and refused consent without exchanging a code", async () => {
    const fetchImplementation = vi.fn();
    await expect(authorizeCloudflareOAuth(clientId, "companyLogin", {
      fetch: fetchImplementation,
      openBrowser: async (url) => {
        await completeAuthorization(url, { state: "wrong-state", code: "unused" });
      },
      timeoutMilliseconds: 1_000,
    })).rejects.toThrow("state mismatch");
    await expect(authorizeCloudflareOAuth(clientId, "companyLogin", {
      fetch: fetchImplementation,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state") as string;
        await completeAuthorization(url, { state, error: "access_denied" });
      },
      timeoutMilliseconds: 1_000,
    })).rejects.toThrow("refused (access_denied)");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("times out safely and rejects redirects, malformed tokens, and scope drift", async () => {
    await expect(authorizeCloudflareOAuth(clientId, "companyLogin", {
      openBrowser: async () => undefined,
      timeoutMilliseconds: 5,
    })).rejects.toThrow("timed out");

    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://example.com" } }),
      Response.json({ access_token: "short" }),
      Response.json(tokenResponse("companyLogin", { scope: "zone.read" })),
    ]) {
      await expect(authorizeCloudflareOAuth(clientId, "companyLogin", {
        fetch: vi.fn(async () => response.clone()),
        openBrowser: async (url) => {
          const state = new URL(url).searchParams.get("state") as string;
          await completeAuthorization(url, { state, code: "qualified-code" });
        },
        timeoutMilliseconds: 1_000,
      })).rejects.toThrow();
    }
  });

  it("refreshes and revokes through non-redirecting form requests", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(input).endsWith("/token")) return Response.json(tokenResponse("companyLogin"));
      return new Response(null, { status: 200 });
    });
    const refreshed = await refreshCloudflareOAuthToken(clientId, `refresh-${"x".repeat(32)}`, fetchImplementation);
    expect(refreshed.access_token).toContain("access-");
    await revokeCloudflareOAuthToken(clientId, refreshed.access_token, fetchImplementation);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("fails closed when granted scopes are missing or unexpectedly broad", () => {
    expect(() => assertExactCloudflareOAuthScopes("companyLogin", "zone.read access-groups.write"))
      .toThrow("wrong OAuth scopes");
  });
});
