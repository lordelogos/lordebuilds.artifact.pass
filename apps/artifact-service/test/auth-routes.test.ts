import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createArtifactApplication } from "../src/server/index";
import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";
import { sha256 } from "../src/server/storage/crypto";

const issuer = "https://artifact-test.cloudflareaccess.com";
const audience = "artifact-test-audience";
const now = Date.parse("2026-08-16T12:00:00.000Z");
const nowSeconds = Math.floor(now / 1000);
const keyId = "test-access-key";

let privateKey: CryptoKey;
let accessJwks: ReturnType<typeof createLocalJWKSet>;

const bindings = (overrides: Record<string, unknown> = {}) => ({
  ...env,
  ACCESS_TEAM_DOMAIN: issuer,
  ACCESS_AUD: audience,
  ...overrides,
});

const application = () => createArtifactApplication({ accessJwks, now: Date.now });

const request = (path: string, init?: RequestInit, overrides?: Record<string, unknown>) =>
  application().fetch(new Request(`https://artifacts.example${path}`, init), bindings(overrides));

const accessToken = async (claims: Partial<JWTPayload> = {}, protectedKid = keyId) =>
  new SignJWT({
    email: "developer@example.com",
    iss: issuer,
    aud: audience,
    sub: "access-user-123",
    iat: nowSeconds - 10,
    exp: nowSeconds + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: protectedKid })
    .sign(privateKey);

const accessHeaders = async (claims: Partial<JWTPayload> = {}) => ({
  "cf-access-jwt-assertion": await accessToken(claims),
});

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const verifierFor = (value: string): string => base64Url(new TextEncoder().encode(value));
const challengeFor = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
};

const startDeviceFlow = async (verifier: string) => {
  const response = await request("/connect/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
    }),
  });
  expect(response.status).toBe(201);
  return response.json<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }>();
};

const approveDeviceFlow = async (userCode: string) =>
  request("/connect/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://artifacts.example",
      ...(await accessHeaders()),
    },
    body: JSON.stringify({ user_code: userCode }),
  });

const exchangeDeviceFlow = async (deviceCode: string, verifier: string) =>
  request("/connect/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode, code_verifier: verifier }),
  });

const createAgentToken = async () => {
  const verifier = verifierFor("a sufficiently long PKCE verifier for this local auth test");
  const device = await startDeviceFlow(verifier);
  expect((await approveDeviceFlow(device.user_code)).status).toBe(204);
  const response = await exchangeDeviceFlow(device.device_code, verifier);
  expect(response.status).toBe(200);
  return response.json<{ access_token: string; token_type: "Bearer"; scope: string; expires_in: number }>();
};

const markdownUpload = () => {
  const form = new FormData();
  form.set("file", new File(["# Exact\n"], "handoff.md", { type: "text/markdown" }));
  form.set("expires_in_seconds", "900");
  return form;
};

beforeAll(async () => {
  const generated = await generateKeyPair("RS256", { extractable: true });
  privateKey = generated.privateKey as CryptoKey;
  const publicJwk = await exportJWK(generated.publicKey);
  accessJwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }] });
});

beforeEach(async () => {
  await reset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await env.ARTIFACT_DB.exec(ARTIFACT_SCHEMA_SQL);
});

afterEach(() => vi.useRealTimers());

describe("Cloudflare Access assertions", () => {
  it("accepts a signed assertion with the configured issuer, audience, time and identity", async () => {
    const verifier = verifierFor("a valid Access identity can inspect this approval request");
    const device = await startDeviceFlow(verifier);
    const response = await request(`/connect/approve?user_code=${device.user_code}`, {
      headers: await accessHeaders(),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user_code: device.user_code });

    const uploadSurface = await request(
      "/upload",
      { headers: await accessHeaders() },
      { ASSETS: { fetch: async () => new Response("upload asset") } },
    );
    expect(uploadSurface.status).toBe(200);
  });

  it.each([
    ["missing", async () => undefined],
    ["wrong audience", async () => accessToken({ aud: "someone-else" })],
    ["expired", async () => accessToken({ exp: nowSeconds - 1 })],
    ["missing issued-at", async () => accessToken({ iat: "not-a-time" as never })],
    ["future issued-at", async () => accessToken({ iat: nowSeconds + 120 })],
    ["missing subject", async () => accessToken({ sub: "" })],
    ["missing email", async () => accessToken({ email: "" })],
  ])("rejects a %s Access assertion", async (_name, makeToken) => {
    const verifier = verifierFor("invalid Access claims cannot inspect an approval request");
    const device = await startDeviceFlow(verifier);
    const token = await makeToken();
    const response = await request(`/connect/approve?user_code=${device.user_code}`, {
      headers: token === undefined ? {} : { "cf-access-jwt-assertion": token },
    });
    expect(response.status).toBe(404);
  });

  it("rejects forged signatures and unknown signing keys", async () => {
    const verifier = verifierFor("forged Access signatures cannot inspect approval state");
    const device = await startDeviceFlow(verifier);
    const forged = `${await accessToken()}.forged`;
    const forgedResponse = await request(`/connect/approve?user_code=${device.user_code}`, {
      headers: { "cf-access-jwt-assertion": forged },
    });
    expect(forgedResponse.status).toBe(404);

    const unknownKeyResponse = await request(`/connect/approve?user_code=${device.user_code}`, {
      headers: { "cf-access-jwt-assertion": await accessToken({}, "rotated-away-key") },
    });
    expect(unknownKeyResponse.status).toBe(404);
  });

  it("rejects a cross-origin browser approval even with a valid Access assertion", async () => {
    const verifier = verifierFor("cross origin approval is rejected before mutating state");
    const device = await startDeviceFlow(verifier);
    const response = await request("/connect/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        ...(await accessHeaders()),
      },
      body: JSON.stringify({ user_code: device.user_code }),
    });
    expect(response.status).toBe(404);
  });
});

describe("device authorization", () => {
  it("accepts only the PKCE S256 challenge method", async () => {
    const verifier = verifierFor("plain PKCE challenges must not be accepted by this service");
    const response = await request("/connect/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code_challenge: await challengeFor(verifier),
        code_challenge_method: "plain",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("mints one scoped 30-day token after one Access-authenticated approval", async () => {
    const verifier = verifierFor("a sufficiently long PKCE verifier for the happy path");
    const device = await startDeviceFlow(verifier);

    expect(device.device_code.length).toBeGreaterThanOrEqual(40);
    expect(device.user_code.length).toBeGreaterThanOrEqual(12);
    expect(device.verification_uri).toBe("https://artifacts.example/connect/approve");
    expect(device.expires_in).toBeLessThanOrEqual(600);
    expect(device.interval).toBeGreaterThanOrEqual(5);
    expect((await approveDeviceFlow(device.user_code)).status).toBe(204);
    expect((await approveDeviceFlow(device.user_code)).status).toBe(409);

    const exchange = await exchangeDeviceFlow(device.device_code, verifier);
    expect(exchange.status).toBe(200);
    const token = await exchange.json<{
      access_token: string;
      token_type: string;
      scope: string;
      expires_in: number;
    }>();
    expect(token.access_token).toMatch(/^as_[A-Za-z0-9_-]{43}$/u);
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("artifact:create");
    expect(token.expires_in).toBe(30 * 24 * 60 * 60);

    const stored = await env.ARTIFACT_DB.prepare(
      "SELECT token_hash, scope, identity_subject, identity_email FROM agent_tokens",
    ).first<{
      token_hash: string;
      scope: string;
      identity_subject: string;
      identity_email: string;
    }>();
    expect(stored).toEqual({
      token_hash: await sha256(token.access_token),
      scope: "artifact:create",
      identity_subject: "access-user-123",
      identity_email: "developer@example.com",
    });
    expect(stored?.token_hash).not.toContain(token.access_token);

    expect((await exchangeDeviceFlow(device.device_code, verifier)).status).toBe(409);
  });

  it("rejects interception without the PKCE verifier without consuming approval", async () => {
    const verifier = verifierFor("the legitimate verifier remains with the connecting CLI");
    const device = await startDeviceFlow(verifier);
    expect((await approveDeviceFlow(device.user_code)).status).toBe(204);

    const interception = await exchangeDeviceFlow(
      device.device_code,
      verifierFor("an attacker cannot guess the original PKCE verifier value"),
    );
    expect(interception.status).toBe(400);
    expect((await exchangeDeviceFlow(device.device_code, verifier)).status).toBe(200);
  });

  it("limits polling and rejects expired device authorizations", async () => {
    const verifier = verifierFor("polling limits need another sufficiently long verifier");
    const device = await startDeviceFlow(verifier);
    expect((await exchangeDeviceFlow(device.device_code, verifier)).status).toBe(202);
    expect((await exchangeDeviceFlow(device.device_code, verifier)).status).toBe(429);

    vi.advanceTimersByTime((device.expires_in + 1) * 1000);
    expect((await exchangeDeviceFlow(device.device_code, verifier)).status).toBe(410);
  });
});

describe("route credential matrix", () => {
  it("lets Access and scoped agents create, while anonymous and public capabilities cannot", async () => {
    const agent = await createAgentToken();
    const accessUpload = await request("/api/artifacts", {
      method: "POST",
      headers: await accessHeaders(),
      body: markdownUpload(),
    });
    expect(accessUpload.status).toBe(201);

    const agentUpload = await request("/api/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.access_token}` },
      body: markdownUpload(),
    });
    expect(agentUpload.status).toBe(201);

    expect((await request("/api/artifacts", { method: "POST", body: markdownUpload() })).status).toBe(404);
    expect(
      (
        await request("/api/artifacts", {
          method: "POST",
          headers: { authorization: "Bearer a-public-share-token" },
          body: markdownUpload(),
        })
      ).status,
    ).toBe(404);
    expect((await request("/api/artifacts", { headers: { authorization: `Bearer ${agent.access_token}` } })).status).toBe(404);
    expect((await request("/a/not-a-share-token", { headers: await accessHeaders() })).status).toBe(404);
  });

  it("keeps browser approval inaccessible to agents and public share tokens", async () => {
    const agent = await createAgentToken();
    expect(
      (
        await request("/connect/approve?user_code=anything", {
          headers: { authorization: `Bearer ${agent.access_token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/upload", {
          headers: { authorization: `Bearer ${agent.access_token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/connect/approve?user_code=anything", {
          headers: { authorization: "Bearer a-public-share-token" },
        })
      ).status,
    ).toBe(404);
  });

  it("revokes one agent token on disconnect without affecting another", async () => {
    const first = await createAgentToken();
    const second = await createAgentToken();
    const disconnect = await request("/api/connection", {
      method: "DELETE",
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(disconnect.status).toBe(204);

    expect(
      (
        await request("/api/artifacts", {
          method: "POST",
          headers: { authorization: `Bearer ${first.access_token}` },
          body: markdownUpload(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/api/artifacts", {
          method: "POST",
          headers: { authorization: `Bearer ${second.access_token}` },
          body: markdownUpload(),
        })
      ).status,
    ).toBe(201);
  });

  it("rejects expired and revoked scoped agent tokens", async () => {
    const agent = await createAgentToken();
    const tokenHash = await sha256(agent.access_token);
    await env.ARTIFACT_DB.prepare("UPDATE agent_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind(now - 1, tokenHash)
      .run();
    expect(
      (
        await request("/api/artifacts", {
          method: "POST",
          headers: { authorization: `Bearer ${agent.access_token}` },
          body: markdownUpload(),
        })
      ).status,
    ).toBe(404);

    await env.ARTIFACT_DB.prepare(
      "UPDATE agent_tokens SET expires_at = ?, revoked_at = ? WHERE token_hash = ?",
    )
      .bind(now + 60_000, now, tokenHash)
      .run();
    expect(
      (
        await request("/api/artifacts", {
          method: "POST",
          headers: { authorization: `Bearer ${agent.access_token}` },
          body: markdownUpload(),
        })
      ).status,
    ).toBe(404);
  });
});
