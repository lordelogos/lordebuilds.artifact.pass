import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPayloadCommitment } from "../../../scripts/publication-commitment.mjs";

import { createArtifactApplication } from "../src/server/index";
import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";
import { sha256 } from "../src/server/storage/crypto";

const now = Date.parse("2026-08-27T12:00:00.000Z");

const bindings = () => ({
  ...env,
  HUMAN_AUTH_MODE: "artifactpass",
  GOOGLE_OAUTH_CLIENT_ID: "google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
  GITHUB_OAUTH_CLIENT_ID: "github-client",
  GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
});

const app = (oauthFetch: typeof fetch = fetch) =>
  createArtifactApplication({ now: Date.now, oauthFetch });

const request = (
  path: string,
  init?: RequestInit,
  oauthFetch?: typeof fetch,
) => app(oauthFetch).fetch(
  new Request(`https://artifactpass.com${path}`, init),
  bindings(),
);

const protectedUploadRequest = (
  path: string,
  init: RequestInit,
  limits: {
    readonly publicUploadMaximumRequests?: number;
    readonly publicUploadMaximumBytes?: number;
  },
) => createArtifactApplication({
  now: Date.now,
  publicUploadWindowMilliseconds: 10 * 60 * 1_000,
  ...limits,
}).fetch(new Request(`https://artifactpass.com${path}`, init), bindings());

const uploadForm = (contents = "# Protected upload"): FormData => {
  const upload = new FormData();
  upload.set("file", new File([contents], "protected-upload.md", { type: "text/markdown" }));
  upload.set("expires_in_seconds", "900");
  return upload;
};

const createStoredAgentToken = async (subject = "google:agent-owner"): Promise<string> => {
  const token = `as_${"a".repeat(43)}`;
  await env.ARTIFACT_DB.prepare(
    `INSERT INTO agent_tokens
      (id, token_hash, identity_subject, identity_email, scope, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, 'artifact:create', ?, ?, NULL)`,
  ).bind(
    "public-auth-agent",
    await sha256(token),
    subject,
    "agent-owner@example.com",
    now,
    now + 30 * 24 * 60 * 60 * 1_000,
  ).run();
  return token;
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const verifier = base64Url(new TextEncoder().encode(
  "a sufficiently long PKCE verifier for public ArtifactPass authentication",
));

const challenge = async (): Promise<string> => base64Url(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
));

const oauthCookie = (response: Response): string => {
  const value = /__Host-artifactpass_oauth=([^;]+)/u.exec(response.headers.get("set-cookie") ?? "")?.[1];
  expect(value).toBeDefined();
  return `__Host-artifactpass_oauth=${value ?? ""}`;
};

const startDeviceFlow = async () => {
  const response = await request("/connect/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code_challenge: await challenge(),
      code_challenge_method: "S256",
    }),
  });
  expect(response.status).toBe(201);
  return response.json<{ readonly device_code: string; readonly user_code: string }>();
};

const createGoogleSession = async (
  returnTo = "/upload",
  subject = "google-user-123",
): Promise<string> => {
  const start = await request(
    `/auth/login/google?return_to=${encodeURIComponent(returnTo)}`,
    { redirect: "manual" },
  );
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const oauthFetch = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "google-access", token_type: "Bearer" });
    }
    if (url.hostname === "openidconnect.googleapis.com") {
      return Response.json({
        sub: subject,
        email: "person@example.com",
        email_verified: true,
      });
    }
    throw new Error(`Unexpected OAuth request: ${url.toString()}`);
  });
  const callback = await request(
    `/auth/callback/google?code=authorization-code&state=${state ?? ""}`,
    { redirect: "manual", headers: { cookie: oauthCookie(start) } },
    oauthFetch,
  );
  expect(callback.status).toBe(302);
  const sessionToken = /__Host-artifactpass_session=([^;]+)/u
    .exec(callback.headers.get("set-cookie") ?? "")?.[1];
  expect(sessionToken).toBeDefined();
  return `__Host-artifactpass_session=${sessionToken ?? ""}`;
};

beforeEach(async () => {
  await reset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await env.ARTIFACT_DB.exec(ARTIFACT_SCHEMA_SQL);
});

describe("public ArtifactPass authentication", () => {
  it("reports that public authentication is ready without exposing provider credentials", async () => {
    const response = await request("/health");
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      human_auth_mode: "artifactpass",
      authentication_configured: true,
    });
    expect(JSON.stringify(body)).not.toContain("google-client");
    expect(JSON.stringify(body)).not.toContain("github-client");
  });

  it("sends an anonymous approval request to an ArtifactPass sign-in page", async () => {
    const device = await startDeviceFlow();
    const response = await request(
      `/connect/approve?user_code=${device.user_code}&format=html`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(`/connect/approve?user_code=${device.user_code}&format=html`)}`,
    );
  });

  it("offers Google and GitHub without exposing Cloudflare authentication", async () => {
    const response = await request("/auth/sign-in?return_to=%2Fupload&theme=light");
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("Continue with Google");
    expect(markup).toContain("Continue with GitHub");
    expect(markup).toContain('data-provider="google"><svg');
    expect(markup).toContain('data-provider="github"><svg');
    expect(markup).toContain('data-artifactpass-mark="capability-corridor"');
    expect(markup).toContain('rel="icon" href="/artifactpass-logo.svg"');
    expect(markup).not.toContain('aria-hidden="true">G</span>');
    expect(markup).not.toContain('aria-hidden="true">GH</span>');
    expect(markup).toContain('data-theme="light"');
    expect(markup).toContain("Secure sign-in");
    expect(markup).toContain("--graphite:#121418");
    expect(markup).not.toContain("Georgia");
    expect(markup).not.toContain("Cloudflare account");
  });

  it("reports the current browser session alongside public upload policy", async () => {
    const anonymous = await request("/upload/preflight");
    expect(anonymous.status).toBe(200);
    await expect(anonymous.json()).resolves.toMatchObject({
      authenticated: false,
      policy: {
        supported_mime_types: ["text/html", "text/markdown", "application/pdf"],
        max_artifact_bytes: 26_214_400,
      },
    });

    const cookie = await createGoogleSession();
    const authenticated = await request("/upload/preflight", { headers: { cookie } });
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toMatchObject({ authenticated: true });
    expect(authenticated.headers.get("cache-control")).toContain("no-store");
  });

  it("skips provider selection when the browser session is already active", async () => {
    const cookie = await createGoogleSession();
    const response = await request(
      `/auth/sign-in?return_to=${encodeURIComponent("/upload?pending=homepage")}`,
      { redirect: "manual", headers: { cookie } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/upload?pending=homepage");
  });

  it("does not start a new provider transaction for an active browser session", async () => {
    const cookie = await createGoogleSession();
    const response = await request(
      `/auth/login/google?return_to=${encodeURIComponent("/upload?pending=homepage")}`,
      { redirect: "manual", headers: { cookie } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/upload?pending=homepage");
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauth_transactions",
    ).first("count")).toBe(0);
  });

  it("treats an expired browser session as signed out everywhere", async () => {
    const cookie = await createGoogleSession();
    await env.ARTIFACT_DB.prepare(
      "UPDATE web_sessions SET expires_at = ?",
    ).bind(Date.now() - 1).run();

    const preflight = await request("/upload/preflight", { headers: { cookie } });
    await expect(preflight.json()).resolves.toMatchObject({ authenticated: false });

    const signIn = await request(
      `/auth/sign-in?return_to=${encodeURIComponent("/upload?pending=homepage")}`,
      { redirect: "manual", headers: { cookie } },
    );
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("Continue with Google");
  });

  it("treats a revoked browser session as signed out on preflight and provider entry", async () => {
    const cookie = await createGoogleSession();
    await env.ARTIFACT_DB.prepare(
      "UPDATE web_sessions SET revoked_at = ?",
    ).bind(Date.now()).run();

    const preflight = await request("/upload/preflight", { headers: { cookie } });
    await expect(preflight.json()).resolves.toMatchObject({ authenticated: false });

    const signIn = await request(
      `/auth/sign-in?return_to=${encodeURIComponent("/upload?pending=homepage")}`,
      { redirect: "manual", headers: { cookie } },
    );
    expect(signIn.status).toBe(200);

    const provider = await request(
      `/auth/login/google?return_to=${encodeURIComponent("/upload?pending=homepage")}`,
      { redirect: "manual", headers: { cookie } },
    );
    expect(provider.status).toBe(302);
    expect(provider.headers.get("location")).toContain("accounts.google.com");
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauth_transactions",
    ).first("count")).toBe(1);
  });

  it("completes popup authentication without replacing the landing page", async () => {
    const page = await request("/auth/popup/complete");
    const script = await request("/auth/popup-complete.js");

    expect(page.status).toBe(200);
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const pageSource = await page.text();
    expect(pageSource).toContain('src="/auth/popup-complete.js"');
    expect(pageSource).toContain('id="completion-fallback"');
    expect(pageSource).toContain("hidden>Continue in this tab");

    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("application/javascript");
    const source = await script.text();
    expect(source).toContain('type: "artifactpass:auth-complete"');
    expect(source).toContain("window.opener.postMessage");
    expect(source).toContain('new BroadcastChannel("artifactpass-auth")');
    expect(source).toContain('sessionStorage.setItem("artifactpass-pending-upload", "1")');
    expect(source).toContain('querySelector("#completion-fallback")?.removeAttribute("hidden")');
    expect(source).not.toContain('window.location.assign("/upload")');
  });

  it("returns a cancelled provider login to the original ArtifactPass tab", async () => {
    const flow = "11111111222233334444555555555555";
    const returnTo = `/auth/popup/complete?theme=light&flow=${flow}`;
    const start = await request(
      `/auth/login/google?return_to=${encodeURIComponent(returnTo)}`,
      { redirect: "manual" },
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const oauthFetch = vi.fn<typeof fetch>();

    const callback = await request(
      `/auth/callback/google?error=access_denied&state=${state ?? ""}`,
      { redirect: "manual", headers: { cookie: oauthCookie(start) } },
      oauthFetch,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`/auth/popup/cancel?theme=light&flow=${flow}`);
    expect(callback.headers.get("set-cookie")).toContain("__Host-artifactpass_oauth=;");
    expect(oauthFetch).not.toHaveBeenCalled();
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauth_transactions",
    ).first("count")).toBe(0);

    const page = await request("/auth/popup/cancel?theme=light");
    const script = await request("/auth/popup-cancel.js");
    expect(page.status).toBe(200);
    const pageSource = await page.text();
    expect(pageSource).toContain('src="/auth/popup-cancel.js"');
    expect(pageSource).toContain("Return to ArtifactPass");
    const source = await script.text();
    expect(source).toContain('type: "artifactpass:auth-cancelled"');
    expect(source).toContain("flow !== null");
    expect(source).toContain('new BroadcastChannel("artifactpass-auth")');
    expect(source).toContain("window.opener.focus()");
    expect(source).toContain("window.close()");
    expect(source).toContain('sessionStorage.setItem("artifactpass-pending-upload", "1")');
    expect(source).toContain('window.location.assign("/?upload=1&auth=cancelled")');
  });

  it("returns a cancelled mobile provider login to its stored document", async () => {
    const start = await request(
      `/auth/login/google?return_to=${encodeURIComponent("/upload?pending=homepage")}`,
      { redirect: "manual" },
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const oauthFetch = vi.fn<typeof fetch>();

    const callback = await request(
      `/auth/callback/google?error=access_denied&state=${state ?? ""}`,
      { redirect: "manual", headers: { cookie: oauthCookie(start) } },
      oauthFetch,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?upload=1&auth=cancelled");
    expect(callback.headers.get("set-cookie")).toContain("__Host-artifactpass_oauth=;");
    expect(oauthFetch).not.toHaveBeenCalled();
  });

  it("completes Google login, stores only a hashed session, and approves the agent", async () => {
    const device = await startDeviceFlow();
    const returnTo = `/connect/approve?user_code=${device.user_code}&format=html`;
    const start = await request(
      `/auth/login/google?return_to=${encodeURIComponent(returnTo)}`,
      { redirect: "manual" },
    );
    expect(start.status).toBe(302);
    const authorizationUrl = new URL(start.headers.get("location") ?? "");
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("google-client");
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const oauthFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "google-access", token_type: "Bearer" });
      }
      if (url.hostname === "openidconnect.googleapis.com") {
        return Response.json({
          sub: "google-user-123",
          email: "person@example.com",
          email_verified: true,
        });
      }
      throw new Error(`Unexpected OAuth request: ${url.toString()}`);
    });
    const callback = await request(
      `/auth/callback/google?code=authorization-code&state=${state ?? ""}`,
      { redirect: "manual", headers: { cookie: oauthCookie(start) } },
      oauthFetch,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(returnTo);
    const cookie = callback.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-artifactpass_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("__Host-artifactpass_oauth=;");
    const sessionToken = /__Host-artifactpass_session=([^;]+)/u.exec(cookie)?.[1];
    expect(sessionToken).toBeDefined();

    const sessionRow = await env.ARTIFACT_DB.prepare(
      "SELECT token_hash, identity_subject, identity_email FROM web_sessions",
    ).first<{ token_hash: string; identity_subject: string; identity_email: string }>();
    expect(sessionRow).toMatchObject({
      identity_subject: "google:google-user-123",
      identity_email: "person@example.com",
    });
    expect(sessionRow?.token_hash).not.toContain(sessionToken ?? "missing");
    expect(oauthFetch.mock.calls.every(([, init]) => init?.signal !== undefined)).toBe(true);

    const page = await request(returnTo, {
      headers: { cookie: `__Host-artifactpass_session=${sessionToken ?? ""}` },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Approve this agent?");

    const approval = await request("/connect/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-artifactpass_session=${sessionToken ?? ""}`,
        origin: "https://artifactpass.com",
      },
      body: new URLSearchParams({ user_code: device.user_code }),
    });
    expect(approval.status).toBe(200);

    const exchange = await request("/connect/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: device.device_code, code_verifier: verifier }),
    });
    expect(exchange.status).toBe(200);
    await expect(exchange.json()).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "artifact:create",
    });
  });

  it("uses a verified primary GitHub email", async () => {
    const start = await request("/auth/login/github?return_to=%2Fupload", { redirect: "manual" });
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const oauthFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/login/oauth/access_token") {
        return Response.json({ access_token: "github-access", token_type: "bearer" });
      }
      if (url.pathname === "/user") return Response.json({ id: 456, login: "octo" });
      if (url.pathname === "/user/emails") {
        return Response.json([
          { email: "other@example.com", primary: false, verified: true },
          { email: "octo@example.com", primary: true, verified: true },
        ]);
      }
      throw new Error(`Unexpected OAuth request: ${url.toString()}`);
    });
    const callback = await request(
      `/auth/callback/github?code=authorization-code&state=${state ?? ""}`,
      { redirect: "manual", headers: { cookie: oauthCookie(start) } },
      oauthFetch,
    );
    expect(callback.status).toBe(302);
    await expect(env.ARTIFACT_DB.prepare(
      "SELECT identity_subject, identity_email FROM web_sessions",
    ).first()).resolves.toMatchObject({
      identity_subject: "github:456",
      identity_email: "octo@example.com",
    });
  });

  it("lets a signed-in person upload while rejecting cross-origin form posts", async () => {
    const cookie = await createGoogleSession();
    const upload = new FormData();
    upload.set("file", new File(["<h1>Public upload</h1>"], "public-upload.html", {
      type: "text/html",
    }));
    upload.set("expires_in_seconds", "900");

    const response = await request("/upload/artifacts", {
      method: "POST",
      headers: { cookie, origin: "https://artifactpass.com" },
      body: upload,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      protocol_version: 1,
      share_url: expect.stringMatching(/^https:\/\/artifactpass\.com\/a\//u),
    });

    const crossOrigin = new FormData();
    crossOrigin.set("file", new File(["unsafe"], "unsafe.md", { type: "text/markdown" }));
    crossOrigin.set("expires_in_seconds", "900");
    const rejected = await request("/upload/artifacts", {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      body: crossOrigin,
    });
    expect(rejected.status).toBe(404);
  });

  it("limits upload attempts for a signed-in person before creating another artifact", async () => {
    const cookie = await createGoogleSession();
    const headers = {
      cookie,
      origin: "https://artifactpass.com",
      "cf-connecting-ip": "203.0.113.20",
    };
    const first = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: uploadForm("first"),
    }, { publicUploadMaximumRequests: 1 });
    expect(first.status).toBe(201);

    const limited = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: uploadForm("second"),
    }, { publicUploadMaximumRequests: 1 });
    expect(limited.status).toBe(429);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count")).toBe(1);
  });

  it("limits upload attempts for an authenticated agent", async () => {
    const token = await createStoredAgentToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": "203.0.113.21",
    };
    const first = await protectedUploadRequest("/api/artifacts", {
      method: "POST",
      headers,
      body: uploadForm("first agent upload"),
    }, { publicUploadMaximumRequests: 1 });
    expect(first.status).toBe(201);

    const limited = await protectedUploadRequest("/api/artifacts", {
      method: "POST",
      headers,
      body: uploadForm("second agent upload"),
    }, { publicUploadMaximumRequests: 1 });
    expect(limited.status).toBe(429);
  });

  it("shares the actor budget across a person's browser and agent connection", async () => {
    const cookie = await createGoogleSession();
    const token = await createStoredAgentToken("google:google-user-123");
    const browserUpload = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://artifactpass.com",
        "cf-connecting-ip": "203.0.113.30",
      },
      body: uploadForm("browser upload"),
    }, { publicUploadMaximumRequests: 1 });
    expect(browserUpload.status).toBe(201);

    const agentUpload = await protectedUploadRequest("/api/artifacts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.31",
      },
      body: uploadForm("agent upload"),
    }, { publicUploadMaximumRequests: 1 });
    expect(agentUpload.status).toBe(429);
  });

  it("shares the network attempt budget across different identities", async () => {
    const firstCookie = await createGoogleSession("/upload", "network-user-one");
    const secondCookie = await createGoogleSession("/upload", "network-user-two");
    const source = "203.0.113.40";
    const first = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers: { cookie: firstCookie, origin: "https://artifactpass.com", "cf-connecting-ip": source },
      body: uploadForm("first identity"),
    }, { publicUploadMaximumRequests: 1 });
    expect(first.status).toBe(201);

    const limited = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers: { cookie: secondCookie, origin: "https://artifactpass.com", "cf-connecting-ip": source },
      body: uploadForm("second identity"),
    }, { publicUploadMaximumRequests: 1 });
    expect(limited.status).toBe(429);
  });

  it("accumulates byte usage across uploads in the same window", async () => {
    const cookie = await createGoogleSession();
    const headers = { cookie, origin: "https://artifactpass.com", "cf-connecting-ip": "203.0.113.41" };
    const first = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: uploadForm("12345"),
    }, { publicUploadMaximumBytes: 12 });
    expect(first.status).toBe(201);

    const limited = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: uploadForm("67890"),
    }, { publicUploadMaximumBytes: 12 });
    expect(limited.status).toBe(429);
  });

  it("does not charge public byte quota twice for an idempotent agent retry", async () => {
    const token = await createStoredAgentToken();
    const source = "# Retry\n";
    const attempt = crypto.randomUUID();
    const shareToken = "R".repeat(43);
    const payloadCommitment = await createPayloadCommitment({
      bytes: new TextEncoder().encode(source),
      expiresInSeconds: 900,
      filename: "retry.md",
      mimeType: "text/markdown",
    });
    const upload = () => {
      const form = new FormData();
      form.set("file", new File([source], "retry.md", { type: "text/markdown" }));
      form.set("expires_in_seconds", "900");
      form.set("publication_attempt", attempt);
      form.set("share_token", shareToken);
      form.set("payload_commitment", payloadCommitment);
      return protectedUploadRequest("/api/artifacts", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.44",
        },
        body: form,
      }, { publicUploadMaximumBytes: 180 });
    };

    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(200);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(1);
  });

  it("recovers a browser publication retry without requiring a client payload commitment", async () => {
    const cookie = await createGoogleSession();
    const attempt = crypto.randomUUID();
    const shareToken = "H".repeat(43);
    const upload = () => {
      const form = uploadForm("# Browser retry\n");
      form.set("publication_attempt", attempt);
      form.set("share_token", shareToken);
      return protectedUploadRequest("/upload/artifacts", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://artifactpass.com",
          "cf-connecting-ip": "203.0.113.45",
        },
        body: form,
      }, { publicUploadMaximumBytes: 240 });
    };

    const first = await upload();
    const retry = await upload();
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      share_url: `https://artifactpass.com/a/${shareToken}`,
    });
    await expect(retry.json()).resolves.toMatchObject({
      share_url: `https://artifactpass.com/a/${shareToken}`,
    });
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(1);
  });

  it("charges browser retry bytes when no client payload commitment proves an exact retry", async () => {
    const cookie = await createGoogleSession();
    const attempt = crypto.randomUUID();
    const shareToken = "Q".repeat(43);
    const headers = {
      cookie,
      origin: "https://artifactpass.com",
      "cf-connecting-ip": "203.0.113.46",
    };
    const first = uploadForm("# First browser payload\n");
    first.set("publication_attempt", attempt);
    first.set("share_token", shareToken);
    expect((await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: first,
    }, { publicUploadMaximumBytes: 160 })).status).toBe(201);

    const mismatchedRetry = uploadForm("# A different browser payload\n");
    mismatchedRetry.set("publication_attempt", attempt);
    mismatchedRetry.set("share_token", shareToken);
    expect((await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: mismatchedRetry,
    }, { publicUploadMaximumBytes: 160 })).status).toBe(429);
  });

  it("counts derived files and rejects unknown multipart fields", async () => {
    const cookie = await createGoogleSession();
    const headers = { cookie, origin: "https://artifactpass.com", "cf-connecting-ip": "203.0.113.42" };
    const derived = uploadForm("12345");
    derived.set("derived_text", new File(["123456"], "derived.md", { type: "text/markdown" }));
    const byteLimited = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers,
      body: derived,
    }, { publicUploadMaximumBytes: 13 });
    expect(byteLimited.status).toBe(429);

    const unknown = uploadForm("ok");
    unknown.set("ignored", "x".repeat(32));
    const rejected = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers: { ...headers, "cf-connecting-ip": "203.0.113.43" },
      body: unknown,
    }, { publicUploadMaximumBytes: 1024 });
    expect(rejected.status).toBe(400);
  });

  it("rejects an upload that exceeds the public byte budget before storing it", async () => {
    const cookie = await createGoogleSession();
    const limited = await protectedUploadRequest("/upload/artifacts", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://artifactpass.com",
        "cf-connecting-ip": "203.0.113.22",
      },
      body: uploadForm("this upload is larger than ten bytes"),
    }, { publicUploadMaximumBytes: 10 });

    expect(limited.status).toBe(429);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count")).toBe(0);
  });

  it("revokes a public session on same-origin logout", async () => {
    const cookie = await createGoogleSession();
    const crossOrigin = await request("/auth/logout", {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
      redirect: "manual",
    });
    expect(crossOrigin.status).toBe(404);

    const logout = await request("/auth/logout", {
      method: "POST",
      headers: { cookie, origin: "https://artifactpass.com" },
      redirect: "manual",
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/auth/sign-in");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM web_sessions WHERE revoked_at IS NOT NULL",
    ).first("count")).toBe(1);

    const protectedPage = await request("/upload", {
      headers: { cookie },
      redirect: "manual",
    });
    expect(protectedPage.status).toBe(302);
    expect(protectedPage.headers.get("location")).toContain("/auth/sign-in?return_to=%2Fupload");
  });

  it("rejects open redirects before creating an OAuth transaction", async () => {
    const response = await request(
      "/auth/login/google?return_to=https%3A%2F%2Fevil.example",
      { redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauth_transactions",
    ).first("count")).toBe(0);
  });

  it("rejects a callback that was not started by the same browser", async () => {
    const start = await request("/auth/login/google?return_to=%2Fupload", { redirect: "manual" });
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const oauthFetch = vi.fn<typeof fetch>();

    const callback = await request(
      `/auth/callback/google?code=authorization-code&state=${state ?? ""}`,
      { redirect: "manual" },
      oauthFetch,
    );

    expect(callback.status).toBe(400);
    expect(oauthFetch).not.toHaveBeenCalled();
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauth_transactions",
    ).first("count")).toBe(1);
  });

  it("bounds OAuth transaction creation by source", async () => {
    for (let index = 0; index < 20; index += 1) {
      const response = await request("/auth/login/google?return_to=%2Fupload", {
        redirect: "manual",
        headers: { "cf-connecting-ip": "203.0.113.10" },
      });
      expect(response.status).toBe(302);
    }
    const limited = await request("/auth/login/google?return_to=%2Fupload", {
      redirect: "manual",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    expect(limited.status).toBe(429);
    expect(await env.ARTIFACT_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauth_transactions",
    ).first("count")).toBe(20);
  });
});
