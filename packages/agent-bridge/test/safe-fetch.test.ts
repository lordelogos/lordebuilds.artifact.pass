import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";

import {
  assertDeploymentOrigin,
  fetchWithoutRedirects,
} from "../src/http/safe-fetch";
import { fetchCloudflareDeploymentRoute } from "../src/http/cloudflare-route-fetch";

const pendingFetch = (): typeof globalThis.fetch =>
  vi.fn(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deployment origin validation", () => {
  it.each([
    "http://localhost:8787",
    "http://service.localhost:8787",
    "http://127.0.0.1:8787",
    "http://10.24.0.5:8787",
    "http://172.16.0.5:8787",
    "http://172.31.255.254:8787",
    "http://192.168.1.5:8787",
    "http://169.254.10.5:8787",
    "http://[::1]:8787",
    "http://[fd12:3456::1]:8787",
    "http://[fe80::1]:8787",
  ])("allows open development on local HTTP origin %s", (origin) => {
    expect(assertDeploymentOrigin(new URL(origin), { openDevelopment: true }).origin)
      .toBe(new URL(origin).origin);
  });

  it.each([
    "http://artifacts.example.com",
    "http://8.8.8.8",
    "http://172.15.255.255:8787",
    "http://172.32.0.1:8787",
    "http://example.trycloudflare.com",
    "https://example.trycloudflare.com",
    "https://localhost:8787",
  ])("rejects open development on non-local HTTP origin %s", (origin) => {
    expect(() => assertDeploymentOrigin(new URL(origin), { openDevelopment: true }))
      .toThrow(/local HTTP origin/u);
  });

  it("preserves managed deployment HTTPS validation", () => {
    expect(assertDeploymentOrigin(new URL("https://artifacts.example.com")).origin)
      .toBe("https://artifacts.example.com");
    expect(() => assertDeploymentOrigin(new URL("http://artifacts.example.com")))
      .toThrow(/HTTPS origin/u);
    expect(() => assertDeploymentOrigin(new URL("https://127.0.0.1")))
      .toThrow(/private network/u);
  });
});

describe("fetchWithoutRedirects", () => {
  it("does not consume a Request body before the primary fetch", async () => {
    const request = new Request("https://artifacts.example.com/connect", {
      method: "POST",
      body: "payload",
    });
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      expect(input).toBe(request);
      expect(request.bodyUsed).toBe(false);
      return Response.json({ ok: true });
    });
    const response = await fetchCloudflareDeploymentRoute(request, {}, { fetch: fetchImplementation });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("preserves a POST request through the successful HTTPS DNS fallback", async () => {
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const fetchImplementation = vi.fn(async () => { throw failure; });
    let sentBody: Buffer | undefined;
    const requestHttps = vi.fn((url, options, callback) => {
      const request = new EventEmitter() as EventEmitter & {
        end(body?: Buffer): void;
        destroy(error?: Error): void;
      };
      request.end = (body?: Buffer) => {
        sentBody = body;
        const incoming = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        incoming.statusCode = 201;
        incoming.headers = { "content-type": "application/json" };
        callback?.(incoming as never);
        incoming.emit("data", Buffer.from('{"created":true}'));
        incoming.emit("end");
      };
      request.destroy = (error?: Error) => {
        if (error !== undefined) request.emit("error", error);
      };
      expect(url).toEqual(new URL("https://artifacts.example.com/connect"));
      expect(options.method).toBe("POST");
      expect(options.headers).toMatchObject({
        authorization: "Bearer test-token",
        "content-type": "text/plain;charset=UTF-8",
      });
      expect(options.lookup).toBeTypeOf("function");
      return request as never;
    }) as unknown as typeof httpsRequest;
    const response = await fetchCloudflareDeploymentRoute(
      new Request("https://artifacts.example.com/connect", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: "payload",
      }),
      { redirect: "error" },
      {
        fetch: fetchImplementation,
        resolve4: vi.fn(async () => ["104.16.132.229"]),
        requestHttps,
      },
    );

    expect(sentBody?.toString("utf8")).toBe("payload");
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ created: true });
  });

  it("applies the transfer-safe default timeout", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const fetchImplementation = pendingFetch();
    const request = fetchWithoutRedirects(
      fetchImplementation,
      new URL("https://artifacts.example.com"),
      { signal: caller.signal },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(vi.mocked(fetchImplementation).mock.calls[0]?.[1]?.signal).not.toBe(caller.signal);
    timeout.abort(new DOMException("request timed out", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("supports a configured timeout", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const request = fetchWithoutRedirects(
      pendingFetch(),
      new URL("https://artifacts.example.com"),
      {},
      { timeoutMs: 250 },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(250);
    timeout.abort(new DOMException("request timed out", "TimeoutError"));

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("composes a caller abort signal with its timeout", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    const request = fetchWithoutRedirects(
      pendingFetch(),
      new URL("https://artifacts.example.com"),
      { signal: caller.signal },
    );

    caller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it("rejects a DNS fallback that resolves to a private address", async () => {
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    await expect(fetchWithoutRedirects(
      vi.fn(async () => { throw failure; }),
      new URL("https://artifacts.example.com"),
      {},
      { resolve4: vi.fn(async () => ["127.0.0.1"]) },
    )).rejects.toThrow(/no public address/u);
  });

  it.each([
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
  ])("rejects special-purpose DNS fallback address %s", async (address) => {
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    await expect(fetchWithoutRedirects(
      vi.fn(async () => { throw failure; }),
      new URL("https://artifacts.example.com"),
      {},
      { resolve4: vi.fn(async () => [address]) },
    )).rejects.toThrow(/no public address/u);
  });

  it("applies the request timeout while DNS fallback is resolving", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const request = fetchWithoutRedirects(
      vi.fn(async () => { throw failure; }),
      new URL("https://artifacts.example.com"),
      {},
      { resolve4: vi.fn(async () => await new Promise<readonly string[]>(() => undefined)) },
    );
    const reason = new Error("DNS resolution timed out");
    timeout.abort(reason);
    await expect(request).rejects.toBe(reason);
  });
});
