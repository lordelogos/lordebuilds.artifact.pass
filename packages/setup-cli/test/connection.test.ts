import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { connectHost } from "../src/commands/connect";
import { disconnectHost } from "../src/commands/disconnect";
import { completeDeviceFlow } from "../src/device-flow";
import { detectHosts, installPluginForHosts } from "../src/hosts";
import type { ProcessRunner } from "../src/process";

const runnerFor = (available: readonly string[]): ProcessRunner => vi.fn(async (command, args) => {
  if (args[0] === "--version") {
    if (!available.includes(command)) throw new Error("missing");
    return { stdout: "1.0.0", stderr: "" };
  }
  if (command === "codex" && args.join(" ") === "plugin marketplace list --json") {
    return { stdout: JSON.stringify({ marketplaces: [] }), stderr: "" };
  }
  if (command === "codex" && args.join(" ") === "plugin list --json") {
    return { stdout: JSON.stringify({ installed: [] }), stderr: "" };
  }
  if (command === "claude" && args.join(" ") === "plugin marketplace list --json") {
    return { stdout: "[]", stderr: "" };
  }
  if (command === "claude" && args.join(" ") === "plugin list --json") {
    return { stdout: "[]", stderr: "" };
  }
  return { stdout: "{}", stderr: "" };
});

describe("host connection", () => {
  it("detects Claude-only, Codex-only, and both-host machines", async () => {
    await expect(detectHosts(runnerFor(["claude"]))).resolves.toEqual(["claude"]);
    await expect(detectHosts(runnerFor(["codex"]))).resolves.toEqual(["codex"]);
    await expect(detectHosts(runnerFor(["codex", "claude"]))).resolves.toEqual(["codex", "claude"]);
  });

  it("installs the same marketplace plugin in both hosts", async () => {
    const runner = runnerFor(["codex", "claude"]);
    await installPluginForHosts(["codex", "claude"], "/trusted/repository", runner);
    expect(runner).toHaveBeenCalledWith("codex", [
      "plugin", "add", "artifact-share@lordebuilds-artifacts", "--json",
    ]);
    expect(runner).toHaveBeenCalledWith("claude", [
      "plugin", "install", "artifact-share@lordebuilds-artifacts", "--scope", "user",
    ]);
  });

  it("configures the portable MCP and skills package without invoking a vendor host", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-portable-connect-test-"));
    const configPath = resolve(root, "config.json");
    const runner: ProcessRunner = vi.fn(async () => {
      throw new Error("a vendor CLI must not run");
    });

    const result = await connectHost({
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      openDevelopment: true,
      installKnownHostAdapters: false,
    }, {
      runner,
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: "lordebuilds.artifacts.share",
          status: "ok",
          pdf_provenance_key_id: "artifactpass-primary",
        }))),
      },
    });

    expect(result).toEqual({ hosts: [], configPath });
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    });
  });

  it("reinstalls its own cached plugin so updated bridge code is loaded", async () => {
    const runner: ProcessRunner = vi.fn(async (command, args) => {
      if (command === "codex" && args.join(" ") === "plugin marketplace list --json") {
        return { stdout: JSON.stringify({ marketplaces: [{ name: "lordebuilds-artifacts" }] }), stderr: "" };
      }
      if (command === "codex" && args.join(" ") === "plugin list --json") {
        return { stdout: JSON.stringify({ installed: [{ pluginId: "artifact-share@lordebuilds-artifacts" }] }), stderr: "" };
      }
      if (command === "claude" && args.join(" ") === "plugin marketplace list --json") {
        return { stdout: JSON.stringify([{ name: "lordebuilds-artifacts" }]), stderr: "" };
      }
      if (command === "claude" && args.join(" ") === "plugin list --json") {
        return { stdout: JSON.stringify([{
          id: "artifact-share@lordebuilds-artifacts",
          scope: "local",
        }]), stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    });
    await installPluginForHosts(["codex", "claude"], "/trusted/repository", runner);
    expect(runner).toHaveBeenCalledWith("codex", [
      "plugin", "remove", "artifact-share@lordebuilds-artifacts",
    ]);
    expect(runner).toHaveBeenCalledWith("claude", [
      "plugin", "uninstall", "artifact-share@lordebuilds-artifacts", "--scope", "local",
    ]);
  });

  it("rejects malformed host CLI output before changing plugin state", async () => {
    const runner: ProcessRunner = vi.fn(async () => ({ stdout: "{}", stderr: "" }));
    await expect(installPluginForHosts(["codex"], "/trusted/repository", runner))
      .rejects.toThrow("unexpected marketplace list");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("completes pending device authorization without exposing the token in the browser URL", async () => {
    const opened: string[] = [];
    const responses = [
      new Response(JSON.stringify({
        device_code: "d".repeat(43),
        user_code: "u".repeat(12),
        verification_uri: "https://artifacts.example.test/connect/approve",
        expires_in: 600,
        interval: 1,
      }), { status: 201 }),
      new Response(JSON.stringify({ status: "authorization_pending", interval: 1 }), { status: 202 }),
      new Response(JSON.stringify({ access_token: `as_${"t".repeat(43)}`, expires_in: 100 }), { status: 200 }),
    ];
    const result = await completeDeviceFlow("https://artifacts.example.test", {
      fetch: vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 })),
      openBrowser: async (url) => { opened.push(url); },
      wait: async () => undefined,
    });
    expect(result.accessToken).toMatch(/^as_/u);
    expect(opened[0]).toContain("user_code=");
    expect(opened[0]).not.toContain(result.accessToken);
  });

  it("retries the same device exchange after a lost token response", async () => {
    const responses: Array<Response | Error> = [
      new Response(JSON.stringify({
        device_code: "d".repeat(43),
        user_code: "u".repeat(12),
        verification_uri: "https://artifacts.example.test/connect/approve",
        expires_in: 600,
        interval: 1,
      }), { status: 201 }),
      new TypeError("connection reset after server response"),
      new Response(JSON.stringify({
        protocol_version: 1,
        error: { code: "forbidden", message: "Authorization was already consumed" },
      }), { status: 409 }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = responses.shift() ?? new Response(null, { status: 500 });
      if (response instanceof Error) throw response;
      return response;
    });

    await expect(completeDeviceFlow("https://artifacts.example.test", {
      fetch,
      openBrowser: async () => undefined,
      wait: async () => undefined,
    })).rejects.toThrow("forbidden");
    expect(fetch).toHaveBeenCalledTimes(3);
    const firstExchange = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as Record<string, string>;
    const retryExchange = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)) as Record<string, string>;
    expect(retryExchange).toEqual(firstExchange);
  });

  it("does not store a token when connection is interrupted", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };
    await expect(connectHost({
      baseUrl: "https://artifacts.example.test",
      workspaceRoots: [process.cwd()],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath: "/tmp/unused-artifact-share-config.json",
    }, {
      runner: runnerFor(["codex"]),
      credentialStore: store,
      deviceFlow: vi.fn(async () => { throw new Error("Connection was interrupted"); }),
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: "lordebuilds.artifacts.share",
          status: "ok",
        }))),
      },
    })).rejects.toThrow("interrupted");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("stores the token only in the credential store and writes non-secret bridge settings", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-connect-test-"));
    const configPath = resolve(root, "config.json");
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };
    const token = `as_${"t".repeat(43)}`;
    const result = await connectHost({
      baseUrl: "https://artifacts.example.test",
      workspaceRoots: [root],
      hosts: ["claude"],
      marketplaceSource: "/trusted/repository",
      configPath,
    }, {
      runner: runnerFor(["claude"]),
      credentialStore: store,
      deviceFlow: vi.fn(async () => ({ accessToken: token, expiresIn: 3600 })),
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: "lordebuilds.artifacts.share",
          status: "ok",
          pdf_provenance_key_id: "artifactpass-primary",
        }))),
      },
    });
    expect(result.hosts).toEqual(["claude"]);
    expect(store.set).toHaveBeenCalledWith(token);
    const persisted = await readFile(configPath, "utf8");
    expect(persisted).toContain("https://artifacts.example.test/");
    expect(persisted).toContain('"pdf_key_id": "artifactpass-primary"');
    expect(persisted).not.toContain(token);
  });

  it("connects an open development origin without resolving or storing a token", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-connect-test-"));
    const configPath = resolve(root, "config.json");
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const deviceFlow = vi.fn();

    const result = await connectHost({
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [root],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath,
      openDevelopment: true,
    }, {
      runner: runnerFor(["codex"]),
      credentialStore: store,
      deviceFlow,
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: "lordebuilds.artifacts.share",
          status: "ok",
        }))),
      },
    });

    expect(result).toEqual({ hosts: ["codex"], configPath });
    expect(deviceFlow).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    });
  });

  it("keeps an existing open development connection open", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-reconnect-test-"));
    const configPath = resolve(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    }));
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };

    await expect(connectHost({
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      openDevelopment: true,
      installKnownHostAdapters: false,
    }, {
      credentialStore: store,
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: "lordebuilds.artifacts.share",
          status: "ok",
        }))),
      },
    })).resolves.toEqual({ hosts: [], configPath });

    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    });
  });

  it("refuses to overwrite an authenticated hosted connection with open development", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-hosted-to-open-test-"));
    const configPath = resolve(root, "config.json");
    const hostedSettings = {
      version: 1 as const,
      base_url: "https://artifacts.example.test/",
      workspace_roots: [root],
    };
    await writeFile(configPath, JSON.stringify(hostedSettings));
    const hostedToken = `as_${"h".repeat(43)}`;
    const store = {
      get: vi.fn().mockResolvedValue(hostedToken),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const runner: ProcessRunner = vi.fn(async () => {
      throw new Error("host installation must not run");
    });
    const writeSettings = vi.fn();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      service: "lordebuilds.artifacts.share",
      status: "ok",
    })));

    await expect(connectHost({
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [root],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath,
      openDevelopment: true,
    }, {
      runner,
      credentialStore: store,
      writeSettings,
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch,
      },
    })).rejects.toThrow(
      "Disconnect the existing hosted Artifact Share connection before connecting to open development",
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(store.get).toHaveBeenCalledOnce();
    expect(store.set).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(await readFile(configPath, "utf8")).toBe(JSON.stringify(hostedSettings));
  });

  it("rejects a local HTTP connection unless open development is explicit", async () => {
    const runner = runnerFor(["codex"]);

    await expect(connectHost({
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [process.cwd()],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
    }, {
      runner,
      deviceFlowDependencies: { openBrowser: async () => undefined },
    })).rejects.toThrow("HTTPS origin");

    expect(runner).not.toHaveBeenCalled();
  });

  it("does not treat a prior open connection as a token-bearing production connection", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-transition-test-"));
    const configPath = resolve(root, "config.json");
    const previousToken = `as_${"o".repeat(43)}`;
    const nextToken = `as_${"n".repeat(43)}`;
    await writeFile(configPath, JSON.stringify({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    }));
    const store = {
      get: vi.fn().mockResolvedValue(previousToken),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }));
      }
      throw new Error(`Unexpected token revocation request to ${url.toString()}`);
    });

    await expect(connectHost({
      baseUrl: "https://artifacts.example.test",
      workspaceRoots: [root],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath,
    }, {
      runner: runnerFor(["codex"]),
      credentialStore: store,
      deviceFlow: vi.fn(async () => ({ accessToken: nextToken, expiresIn: 3600 })),
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch },
    })).resolves.toMatchObject({ expiresIn: 3600 });

    expect(store.set).toHaveBeenCalledWith(nextToken);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("open_development");
  });

  it("revokes before deleting the local credential", async () => {
    const order: string[] = [];
    const store = {
      get: async () => `as_${"t".repeat(43)}`,
      set: vi.fn(),
      delete: async () => { order.push("delete"); },
    };
    await disconnectHost("https://artifacts.example.test", {
      credentialStore: store,
      fetch: vi.fn(async () => { order.push("revoke"); return new Response(null, { status: 204 }); }),
    });
    expect(order).toEqual(["revoke", "delete"]);
  });

  it("fails closed when the credential store cannot be read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(disconnectHost("https://artifacts.example.test", {
      credentialStore: {
        get: async () => { throw new Error("credential store unavailable"); },
        set: vi.fn(),
        delete: vi.fn(),
      },
      fetch,
    })).rejects.toThrow("credential store unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes a newly issued token when local persistence fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-persistence-test-"));
    const token = `as_${"n".repeat(43)}`;
    const store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }));
      }
      expect(init?.headers).toEqual({ Authorization: `Bearer ${token}` });
      return new Response(null, { status: 204 });
    });

    await expect(connectHost({
      baseUrl: "https://artifacts.example.test",
      workspaceRoots: [process.cwd()],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath: resolve(root, "config.json"),
    }, {
      runner: runnerFor(["codex"]),
      credentialStore: store,
      deviceFlow: vi.fn(async () => ({ accessToken: token, expiresIn: 3600 })),
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch },
      writeSettings: vi.fn(async () => { throw new Error("config write failed"); }),
    })).rejects.toThrow();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://artifacts.example.test/api/connection"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("rolls a reconnect back if the previous token cannot be revoked", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-reconnect-test-"));
    const configPath = resolve(root, "config.json");
    const previousToken = `as_${"o".repeat(43)}`;
    const nextToken = `as_${"n".repeat(43)}`;
    await writeFile(configPath, JSON.stringify({
      version: 1,
      base_url: "https://old-artifacts.example.test/",
      workspace_roots: [root],
    }));
    let storedToken = previousToken;
    const store = {
      get: vi.fn(async () => storedToken),
      set: vi.fn(async (value: string) => { storedToken = value; }),
      delete: vi.fn(async () => { storedToken = ""; }),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }));
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return new Response(null, { status: authorization === `Bearer ${previousToken}` ? 500 : 204 });
    });

    await expect(connectHost({
      baseUrl: "https://new-artifacts.example.test",
      workspaceRoots: [root],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath,
    }, {
      runner: runnerFor(["codex"]),
      credentialStore: store,
      deviceFlow: vi.fn(async () => ({ accessToken: nextToken, expiresIn: 3600 })),
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch },
    })).rejects.toThrow("Could not revoke");

    expect(storedToken).toBe(previousToken);
    expect(await readFile(configPath, "utf8")).toContain("https://old-artifacts.example.test/");
  });
});
