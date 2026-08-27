import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { bindAgentCredential } from "agent-bridge";

import { connectHost } from "../src/commands/connect";
import { disconnectHost, selectDisconnectProfile } from "../src/commands/disconnect";
import { completeDeviceFlow } from "../src/device-flow";
import { detectHosts, installPluginForHosts } from "../src/hosts";
import type { ProcessRunner } from "../src/process";

const hostBinding = {
  configPath: "/private/config/artifactpass/config.json",
  profileName: "staging-eval",
  bridgePath: "/private/config/artifactpass/portable-integration/digest/plugin/dist/cli.mjs",
} as const;

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
  it("resolves legacy disconnect URLs to the matching profile", () => {
    const settings = {
      version: 2 as const,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          workspace_roots: ["/tmp/artifacts"],
          open_development: true as const,
        },
        production: {
          base_url: "https://artifactpass.com/",
          workspace_roots: ["/tmp/artifacts"],
        },
      },
    };

    expect(selectDisconnectProfile(settings, { baseUrl: "https://artifactpass.com" }).name)
      .toBe("production");
    expect(() => selectDisconnectProfile(settings, { baseUrl: "https://unknown.example" }))
      .toThrow("No ArtifactPass profile uses");
    expect(() => selectDisconnectProfile(settings, {
      profileName: "local",
      baseUrl: "https://artifactpass.com",
    })).toThrow("does not use");
  });

  it("keeps local and production connections as separate profiles", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-profile-connect-test-"));
    const configPath = resolve(root, "config.json");
    const localStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const productionStore = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), delete: vi.fn() };
    const health = vi.fn(async (input: RequestInfo | URL) => {
      const origin = new URL(input instanceof Request ? input.url : input.toString()).origin;
      return new Response(JSON.stringify({
        service: "lordebuilds.artifacts.share",
        status: "ok",
        ...(origin === "https://artifactpass.com"
          ? { pdf_provenance_key_id: "artifactpass-primary" }
          : {}),
      }));
    });

    await connectHost({
      profileName: "local",
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      openDevelopment: true,
      installKnownHostAdapters: false,
    }, {
      credentialStore: localStore,
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch: health },
    });
    await connectHost({
      profileName: "production",
      baseUrl: "https://artifactpass.com",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      installKnownHostAdapters: false,
    }, {
      credentialStore: productionStore,
      deviceFlow: vi.fn(async () => ({ accessToken: `as_${"p".repeat(43)}`, expiresIn: 3600 })),
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch: health },
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 2,
      active_profile: "production",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          credential_namespace: "artifactpass",
          workspace_roots: [root],
          open_development: true,
        },
        production: {
          base_url: "https://artifactpass.com/",
          credential_binding: "origin",
          credential_namespace: "artifactpass",
          workspace_roots: [root],
          pdf_key_id: "artifactpass-primary",
        },
      },
    });
    expect(localStore.get).not.toHaveBeenCalled();
    expect(productionStore.set).toHaveBeenCalledWith(bindAgentCredential(
      "https://artifactpass.com",
      `as_${"p".repeat(43)}`,
    ));
  });

  it("detects Claude-only, Codex-only, and both-host machines", async () => {
    await expect(detectHosts(runnerFor(["claude"]))).resolves.toEqual(["claude"]);
    await expect(detectHosts(runnerFor(["codex"]))).resolves.toEqual(["codex"]);
    await expect(detectHosts(runnerFor(["codex", "claude"]))).resolves.toEqual(["codex", "claude"]);
  });

  it("installs the same marketplace plugin in both hosts", async () => {
    const runner = runnerFor(["codex", "claude"]);
    await installPluginForHosts(["codex", "claude"], "/trusted/repository", hostBinding, runner);
    expect(runner).toHaveBeenCalledWith("codex", [
      "plugin", "add", "artifactpass@artifactpass", "--json",
    ]);
    expect(runner).toHaveBeenCalledWith("claude", [
      "plugin", "install", "artifactpass@artifactpass", "--scope", "user",
    ]);
    expect(runner).toHaveBeenCalledWith("codex", [
      "mcp", "add", "artifactpass",
      "--env", `ARTIFACTPASS_CONFIG_PATH=${hostBinding.configPath}`,
      "--env", `ARTIFACTPASS_PROFILE=${hostBinding.profileName}`,
      "--", process.execPath, hostBinding.bridgePath,
    ]);
    expect(runner).toHaveBeenCalledWith("claude", [
      "mcp", "add", "--scope", "user", "artifactpass",
      "-e", `ARTIFACTPASS_CONFIG_PATH=${hostBinding.configPath}`,
      "-e", `ARTIFACTPASS_PROFILE=${hostBinding.profileName}`,
      "--", process.execPath, hostBinding.bridgePath,
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

    expect(result).toEqual({ hosts: [], profileName: "local", configPath });
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          credential_namespace: "artifactpass",
          workspace_roots: [root],
          open_development: true,
        },
      },
    });
  });

  it("returns portable registration paths when no automatic host is detected", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-undetected-host-test-"));
    const configPath = resolve(root, "config.json");
    const portableIntegration = {
      digest: "a".repeat(64),
      rootDirectory: resolve(root, "portable"),
      mcpConfig: resolve(root, "portable", "mcp.json"),
      skillsDirectory: resolve(root, "portable", "plugin", "skills"),
    };
    const installPortable = vi.fn().mockResolvedValue(portableIntegration);

    const result = await connectHost({
      baseUrl: "http://127.0.0.1:8787",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      openDevelopment: true,
    }, {
      runner: runnerFor([]),
      installPortable,
      deviceFlowDependencies: {
        openBrowser: async () => undefined,
        fetch: vi.fn(async () => new Response(JSON.stringify({
          service: "lordebuilds.artifacts.share",
          status: "ok",
        }))),
      },
    });

    expect(result).toEqual({
      hosts: [],
      profileName: "local",
      configPath,
      portableIntegration,
    });
    expect(installPortable).toHaveBeenCalledWith({
      sourceRoot: "/trusted/repository/plugins/artifactpass",
    });
  });

  it("refreshes ArtifactPass without removing the legacy compatibility plugin", async () => {
    const runner: ProcessRunner = vi.fn(async (command, args) => {
      if (command === "codex" && args.join(" ") === "plugin marketplace list --json") {
        return { stdout: JSON.stringify({ marketplaces: [{ name: "artifactpass" }] }), stderr: "" };
      }
      if (command === "codex" && args.join(" ") === "plugin list --json") {
        return { stdout: JSON.stringify({ installed: [
          { pluginId: "artifactpass@artifactpass" },
          { pluginId: "artifact-share@lordebuilds-artifacts" },
        ] }), stderr: "" };
      }
      if (command === "claude" && args.join(" ") === "plugin marketplace list --json") {
        return { stdout: JSON.stringify([{ name: "artifactpass" }]), stderr: "" };
      }
      if (command === "claude" && args.join(" ") === "plugin list --json") {
        return { stdout: JSON.stringify([{
          id: "artifactpass@artifactpass",
          scope: "local",
        }, {
          id: "artifact-share@lordebuilds-artifacts",
          scope: "user",
        }]), stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    });
    await installPluginForHosts(["codex", "claude"], "/trusted/repository", hostBinding, runner);
    expect(runner).toHaveBeenCalledWith("codex", [
      "plugin", "remove", "artifactpass@artifactpass",
    ]);
    expect(runner).toHaveBeenCalledWith("claude", [
      "plugin", "uninstall", "artifactpass@artifactpass", "--scope", "local",
    ]);
    expect(runner).not.toHaveBeenCalledWith("codex", [
      "plugin", "remove", "artifact-share@lordebuilds-artifacts",
    ]);
    expect(runner).not.toHaveBeenCalledWith("claude", [
      "plugin", "uninstall", "artifact-share@lordebuilds-artifacts", "--scope", "user",
    ]);
  });

  it("rejects malformed host CLI output before changing plugin state", async () => {
    const runner: ProcessRunner = vi.fn(async () => ({ stdout: "{}", stderr: "" }));
    await expect(installPluginForHosts(["codex"], "/trusted/repository", hostBinding, runner))
      .rejects.toThrow("unexpected marketplace list");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("restores previously installed host registrations when a later host fails", async () => {
    let claudeUserInstallAttempts = 0;
    let codexInstallAttempts = 0;
    const runner: ProcessRunner = vi.fn(async (command, args) => {
      const joined = args.join(" ");
      if (command === "codex" && joined === "plugin marketplace list --json") {
        return { stdout: JSON.stringify({ marketplaces: [{ name: "artifactpass" }] }), stderr: "" };
      }
      if (command === "codex" && joined === "plugin list --json") {
        return { stdout: JSON.stringify({ installed: [{ pluginId: "artifactpass@artifactpass" }] }), stderr: "" };
      }
      if (command === "claude" && joined === "plugin marketplace list --json") {
        return { stdout: JSON.stringify([{ name: "artifactpass" }]), stderr: "" };
      }
      if (command === "claude" && joined === "plugin list --json") {
        return { stdout: JSON.stringify([{ id: "artifactpass@artifactpass", scope: "local" }]), stderr: "" };
      }
      if (command === "claude" && joined === "plugin install artifactpass@artifactpass --scope user") {
        claudeUserInstallAttempts += 1;
        if (claudeUserInstallAttempts === 1) throw new Error("injected Claude install failure");
      }
      if (command === "codex" && joined === "plugin add artifactpass@artifactpass --json") {
        codexInstallAttempts += 1;
      }
      return { stdout: "{}", stderr: "" };
    });

    await expect(installPluginForHosts(["codex", "claude"], "/trusted/repository", hostBinding, runner))
      .rejects.toThrow("injected Claude install failure");

    expect(codexInstallAttempts).toBe(2);
    expect(runner).toHaveBeenCalledWith("codex", ["mcp", "remove", "artifactpass"]);
    expect(runner).toHaveBeenCalledWith("claude", [
      "plugin", "install", "artifactpass@artifactpass", "--scope", "local",
    ]);
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

  it("continues with a copyable approval URL when the browser cannot open", async () => {
    const manual: string[] = [];
    const responses = [
      new Response(JSON.stringify({
        device_code: "d".repeat(43),
        user_code: "u".repeat(12),
        verification_uri: "https://artifactpass.com/connect/approve",
        expires_in: 600,
        interval: 1,
      }), { status: 201 }),
      new Response(JSON.stringify({ access_token: `as_${"t".repeat(43)}`, expires_in: 100 })),
    ];

    await expect(completeDeviceFlow("https://artifactpass.com", {
      fetch: vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 })),
      openBrowser: async () => { throw new Error("no browser"); },
      onManualApprovalRequired: (url) => { manual.push(url); },
      wait: async () => undefined,
    })).resolves.toMatchObject({ expiresIn: 100 });

    expect(manual).toHaveLength(1);
    expect(manual[0]).toContain("user_code=");
    expect(manual[0]).not.toContain("as_");
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
    expect(store.set).toHaveBeenCalledWith(bindAgentCredential("https://artifacts.example.test", token));
    const persisted = await readFile(configPath, "utf8");
    expect(persisted).toContain("https://artifacts.example.test/");
    expect(persisted).toContain('"pdf_key_id": "artifactpass-primary"');
    expect(persisted).not.toContain(token);
  });

  it("reuses a valid scoped credential without opening browser approval", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-reuse-connection-test-"));
    const configPath = resolve(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      version: 2,
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifactpass.com/",
          workspace_roots: [root],
          credential_namespace: "artifactpass",
        },
      },
    }));
    const token = `as_${"t".repeat(43)}`;
    const store = {
      get: vi.fn().mockResolvedValue(token),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const deviceFlow = vi.fn();
    const expiresAt = Date.parse("2026-08-18T00:00:00.000Z");
    const now = Date.parse("2026-08-17T23:00:00.000Z");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === "/health"
        ? new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }))
        : new Response(JSON.stringify({
            protocol_version: 1,
            status: "active",
            scope: "artifact:create",
            expires_at: expiresAt,
          }));
    });

    const result = await connectHost({
      baseUrl: "https://artifactpass.com",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      installKnownHostAdapters: false,
    }, {
      credentialStore: store,
      deviceFlow,
      now: () => now,
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch },
    });

    expect(result).toMatchObject({
      credentialAction: "reused",
      expiresIn: 3600,
    });
    expect(deviceFlow).not.toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledWith(bindAgentCredential("https://artifactpass.com", token));
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("never sends an existing token to a newly selected deployment", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-retarget-connection-test-"));
    const configPath = resolve(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      version: 2,
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifactpass.com/",
          workspace_roots: [root],
          credential_namespace: "artifactpass",
        },
      },
    }));
    const previousToken = `as_${"o".repeat(43)}`;
    const nextToken = `as_${"n".repeat(43)}`;
    const store = {
      get: vi.fn().mockResolvedValue(previousToken),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }));
      }
      if (url.origin === "https://artifactpass.com" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    await connectHost({
      baseUrl: "https://artifacts.company.example",
      workspaceRoots: [root],
      marketplaceSource: "/trusted/repository",
      configPath,
      installKnownHostAdapters: false,
    }, {
      credentialStore: store,
      deviceFlow: vi.fn(async () => ({ accessToken: nextToken, expiresIn: 3600 })),
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch },
    });

    expect(fetch.mock.calls.some(([input, init]) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.origin === "https://artifacts.company.example" &&
        new Headers(init?.headers).get("authorization") === `Bearer ${previousToken}`;
    })).toBe(false);
    expect(store.set).toHaveBeenCalledWith(bindAgentCredential("https://artifacts.company.example", nextToken));
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

    expect(result).toEqual({ hosts: ["codex"], profileName: "local", configPath });
    expect(deviceFlow).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          credential_namespace: "artifactpass",
          workspace_roots: [root],
          open_development: true,
        },
      },
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
    })).resolves.toEqual({ hosts: [], profileName: "local", configPath });

    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          credential_namespace: "artifactpass",
          workspace_roots: [root],
          open_development: true,
          publication_state: "legacy",
        },
      },
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
      profileName: "production",
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
      "Disconnect the existing hosted ArtifactPass production profile before replacing it with open development",
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
    const nextToken = `as_${"n".repeat(43)}`;
    await writeFile(configPath, JSON.stringify({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    }));
    const store = {
      get: vi.fn().mockResolvedValue(null),
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

    expect(store.set).toHaveBeenCalledWith(bindAgentCredential("https://artifacts.example.test", nextToken));
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

  it("rolls back plugin, config, and new credential when MCP verification fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-smoke-rollback-test-"));
    const configPath = resolve(root, "config.json");
    const token = `as_${"n".repeat(43)}`;
    const store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const runner = runnerFor(["codex"]);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ service: "lordebuilds.artifacts.share", status: "ok" }));
      }
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });

    await expect(connectHost({
      baseUrl: "https://artifactpass.com",
      workspaceRoots: [root],
      hosts: ["codex"],
      marketplaceSource: "/trusted/repository",
      configPath,
    }, {
      runner,
      credentialStore: store,
      deviceFlow: vi.fn(async () => ({ accessToken: token, expiresIn: 3600 })),
      verifyConnection: async () => { throw new Error("MCP smoke failed"); },
      deviceFlowDependencies: { openBrowser: async () => undefined, fetch },
    })).rejects.toThrow("MCP smoke failed");

    expect(store.set).toHaveBeenCalledWith(bindAgentCredential("https://artifactpass.com", token));
    expect(store.delete).toHaveBeenCalledOnce();
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner).toHaveBeenCalledWith("codex", [
      "plugin", "remove", "artifactpass@artifactpass",
    ]);
    expect(runner).toHaveBeenCalledWith("codex", [
      "plugin", "marketplace", "remove", "artifactpass",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://artifactpass.com/api/connection"),
      expect.objectContaining({ method: "DELETE" }),
    );
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
      if (url.pathname === "/api/connection" && init?.method !== "DELETE") {
        return new Response(null, { status: 404 });
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
