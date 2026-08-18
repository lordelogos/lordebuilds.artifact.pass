import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { artifactErrorSchema, PROTOCOL_VERSION } from "../packages/artifact-protocol/src/index";

import {
  createTunnelGateway,
  findLanIpv4Address,
  generateUploadToken,
  parseQuickTunnelUrl,
  quickTunnelArguments,
  startQuickTunnel,
} from "../scripts/network-demo.mjs";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

const healthBody = { service: "lordebuilds.artifacts.share", status: "ok" };

const localService = async (reportedHealth: unknown = healthBody) => {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reportedHealth));
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

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

const fakeChild = (): FakeChild => Object.assign(new EventEmitter(), {
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  exitCode: null,
  signalCode: null,
  kill: vi.fn(),
});

const fakeGateway = (close = vi.fn<() => Promise<void>>(async () => undefined)) => ({
  uploadToken: "T".repeat(43),
  localOrigin: new URL("http://127.0.0.1:49152"),
  close,
});

const startWithFakes = async ({
  child = fakeChild(),
  gateway = fakeGateway(),
  fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify(healthBody))
  ),
  removeDirectory = vi.fn<() => Promise<void>>(async () => undefined),
  stopProcess = vi.fn<() => Promise<void>>(async () => undefined),
} = {}) => {
  const spawnProcess = vi.fn(() => {
    queueMicrotask(() => child.stderr.write("ready https://quiet-tree-42.trycloudflare.com now"));
    return child;
  });
  const session = await startQuickTunnel({
    createGateway: vi.fn(async () => gateway),
    fetchImplementation,
    makeTemporaryDirectory: vi.fn(async () => "/private/artifact-share-test"),
    readinessDelayMs: 0,
    readinessTimeoutMs: 100,
    removeDirectory,
    spawnProcess,
    stopProcess,
    timeoutMs: 100,
    writeConfiguration: vi.fn(async () => undefined),
  });
  return { child, gateway, removeDirectory, session, spawnProcess, stopProcess };
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
    expect(parseQuickTunnelUrl("https://quiet-tree-42.trycloudflare.com.attacker.example"))
      .toBeUndefined();
    expect(parseQuickTunnelUrl("(https://quiet-tree-42.trycloudflare.com),")?.origin)
      .toBe("https://quiet-tree-42.trycloudflare.com");
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
    const deniedAgent = await fetch(new URL("/api/artifacts", gateway.localOrigin), {
      method: "POST",
      body: "x",
    });
    expect(deniedAgent.status).toBe(401);
    expect(artifactErrorSchema.parse(await deniedAgent.json())).toEqual({
      protocol_version: PROTOCOL_VERSION,
      error: {
        code: "unauthorized",
        message: "A temporary Quick Tunnel upload token is required",
      },
    });

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

  it("rejects a loopback service that does not identify as ArtifactPass", async () => {
    const unrelated = await localService({ status: "ok" });

    await expect(createTunnelGateway({ targetOrigin: unrelated.origin }))
      .rejects.toThrow(/not healthy/u);
  });

  it("bounds a never-resolving initial health request", async () => {
    const never = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));

    await expect(createTunnelGateway({
      targetOrigin: "http://127.0.0.1:49152",
      fetchImplementation: never,
      healthTimeoutMs: 20,
    })).rejects.toThrow(/timed out after 20ms/u);
    expect(never.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(never.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it("bounds a never-resolving edge health request and cleans up", async () => {
    const child = fakeChild();
    const gateway = fakeGateway();
    const removeDirectory = vi.fn(async () => undefined);
    const stopProcess = vi.fn(async () => undefined);
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(() =>
      new Promise<Response>(() => undefined)
    );
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.stderr.write("https://quiet-tree-42.trycloudflare.com"));
      return child;
    });

    await expect(startQuickTunnel({
      createGateway: vi.fn(async () => gateway),
      fetchImplementation,
      makeTemporaryDirectory: vi.fn(async () => "/private/artifact-share-test"),
      readinessDelayMs: 0,
      readinessTimeoutMs: 20,
      removeDirectory,
      spawnProcess,
      stopProcess,
      timeoutMs: 100,
      writeConfiguration: vi.fn(async () => undefined),
    })).rejects.toThrow(/did not become reachable within 20ms/u);

    expect(stopProcess).toHaveBeenCalledWith(child);
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it("does not accept an unrelated service through the tunnel edge", async () => {
    const child = fakeChild();
    const gateway = fakeGateway();
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: "ok" }))
    );
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.stderr.write("https://quiet-tree-42.trycloudflare.com"));
      return child;
    });

    await expect(startQuickTunnel({
      createGateway: vi.fn(async () => gateway),
      fetchImplementation,
      makeTemporaryDirectory: vi.fn(async () => "/private/artifact-share-test"),
      readinessDelayMs: 0,
      readinessTimeoutMs: 20,
      removeDirectory: vi.fn(async () => undefined),
      spawnProcess,
      stopProcess: vi.fn(async () => undefined),
      timeoutMs: 100,
      writeConfiguration: vi.fn(async () => undefined),
    })).rejects.toThrow(/unexpected health response/u);

    expect(fetchImplementation).toHaveBeenCalled();
    expect(gateway.close).toHaveBeenCalledTimes(1);
  });

  it("attempts every cleanup operation and reports all failures", async () => {
    const gatewayFailure = new Error("gateway close failed");
    const stopFailure = new Error("cloudflared stop failed");
    const removeFailure = new Error("config removal failed");
    const gateway = fakeGateway(vi.fn(async () => { throw gatewayFailure; }));
    const removeDirectory = vi.fn(async () => { throw removeFailure; });
    const stopProcess = vi.fn(async () => { throw stopFailure; });
    const { session } = await startWithFakes({ gateway, removeDirectory, stopProcess });

    const failure = await session.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      stopFailure,
      gatewayFailure,
      removeFailure,
    ]);
    expect(stopProcess).toHaveBeenCalledTimes(1);
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledTimes(1);
  });

  it("preserves a startup failure alongside every cleanup failure", async () => {
    const gatewayFailure = new Error("gateway close failed");
    const removeFailure = new Error("config removal failed");
    const gateway = fakeGateway(vi.fn(async () => { throw gatewayFailure; }));

    const failure = await startQuickTunnel({
      createGateway: vi.fn(async () => gateway),
      makeTemporaryDirectory: vi.fn(async () => "/private/artifact-share-test"),
      removeDirectory: vi.fn(async () => { throw removeFailure; }),
      spawnProcess: vi.fn(() => { throw new Error("spawn failed"); }),
      timeoutMs: 100,
      writeConfiguration: vi.fn(async () => undefined),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    expect((failure as AggregateError).errors[0]).toMatchObject({
      message: "Could not start cloudflared: spawn failed",
    });
    expect((failure as AggregateError).errors.slice(1)).toEqual([
      gatewayFailure,
      removeFailure,
    ]);
  });

  it("makes concurrent close calls await the same in-flight cleanup", async () => {
    let releaseGateway!: () => void;
    const gatewayClosed = new Promise<void>((resolve) => { releaseGateway = resolve; });
    const gateway = fakeGateway(vi.fn<() => Promise<void>>(() => gatewayClosed));
    const removeDirectory = vi.fn(async () => undefined);
    const { child, session } = await startWithFakes({ gateway, removeDirectory });

    child.exitCode = 0;
    child.emit("exit", 0);
    let firstFinished = false;
    let secondFinished = false;
    const firstClose = session.close();
    const secondClose = session.close();
    expect(secondClose).toBe(firstClose);
    const first = firstClose.then(() => { firstFinished = true; });
    const second = secondClose.then(() => { secondFinished = true; });
    await Promise.resolve();

    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);
    expect(gateway.close).toHaveBeenCalledTimes(1);
    releaseGateway();
    await Promise.all([first, second]);
    await expect(session.close()).resolves.toBeUndefined();
    expect(removeDirectory).toHaveBeenCalledTimes(1);
  });
});
