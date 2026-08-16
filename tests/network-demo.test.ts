import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTunnelGateway,
  findLanIpv4Address,
  generateUploadToken,
  parseQuickTunnelUrl,
  quickTunnelArguments,
} from "../scripts/network-demo.mjs";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

const localService = async () => {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (["/upload/artifacts", "/api/artifacts"].includes(request.url ?? "") && request.method === "POST") {
      if (request.url === "/upload/artifacts" && request.headers.origin !== `http://${request.headers.host}`) {
        response.writeHead(403);
        response.end();
        return;
      }
      request.resume();
      request.once("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ share_url: "http://127.0.0.1:8787/a/share-token" }));
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("public read");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  const close = async () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  cleanup.push(close);
  return { origin: `http://127.0.0.1:${address.port}`, close };
};

describe("network demo helpers", () => {
  it("creates a cryptographically sized process token", () => {
    expect(generateUploadToken(new Uint8Array(32).fill(7))).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => generateUploadToken(new Uint8Array(31))).toThrow(/at least 32/u);
  });

  it("selects only an active non-loopback LAN IPv4 address", () => {
    expect(findLanIpv4Address({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.168.1.22", family: "IPv4", internal: false }],
    })).toBe("192.168.1.22");
  });

  it("extracts only a Cloudflare Quick Tunnel URL", () => {
    expect(parseQuickTunnelUrl("ready https://quiet-tree-42.trycloudflare.com now")?.origin)
      .toBe("https://quiet-tree-42.trycloudflare.com");
    expect(parseQuickTunnelUrl("https://example.com")).toBeUndefined();
  });

  it("forces cloudflared to use the helper's isolated configuration", () => {
    expect(quickTunnelArguments("/private/config.yaml", "http://127.0.0.1:9012/"))
      .toEqual([
        "tunnel",
        "--config", "/private/config.yaml",
        "--url", "http://127.0.0.1:9012/",
        "--no-autoupdate",
        "--protocol", "http2",
      ]);
  });

  it("keeps reads public, rejects anonymous uploads, and accepts bearer or browser-session uploads", async () => {
    const upstream = await localService();
    const token = generateUploadToken();
    const gateway = await createTunnelGateway({ targetOrigin: upstream.origin, uploadToken: token });
    cleanup.unshift(gateway.close);

    expect(await (await fetch(new URL("/a/public", gateway.localOrigin))).text()).toBe("public read");
    expect((await fetch(new URL("/__local-test/time", gateway.localOrigin))).status).toBe(404);
    expect((await fetch(new URL("/connect", gateway.localOrigin))).status).toBe(404);
    expect((await fetch(new URL("/connect/device", gateway.localOrigin), { method: "POST" })).status).toBe(404);
    expect((await fetch(new URL("/upload/artifacts", gateway.localOrigin), { method: "POST", body: "x" })).status).toBe(401);
    expect((await fetch(new URL("/api/artifacts", gateway.localOrigin), { method: "POST", body: "x" })).status).toBe(401);

    const agentUpload = await fetch(new URL("/api/artifacts", gateway.localOrigin), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "agent",
    });
    expect(agentUpload.status).toBe(201);
    expect((await agentUpload.json()).share_url).toBe(`${gateway.localOrigin.origin}/a/share-token`);

    const authorize = await fetch(new URL("/__artifact-share-tunnel/authorize", gateway.localOrigin), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      redirect: "manual",
    });
    expect(authorize.status).toBe(303);
    const cookie = authorize.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^__Host-artifact-share-tunnel=/u);
    expect(cookie).not.toContain(token);

    const browserUpload = await fetch(new URL("/upload/artifacts", gateway.localOrigin), {
      method: "POST",
      headers: { cookie: cookie ?? "", origin: gateway.localOrigin.origin },
      body: "browser",
    });
    expect(browserUpload.status).toBe(201);
  });
});
