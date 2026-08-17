import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertDeploymentOrigin,
  fetchWithoutRedirects,
} from "../src/http/safe-fetch";

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
});
