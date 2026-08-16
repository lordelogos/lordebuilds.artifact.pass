import { mkdtemp, readFile } from "node:fs/promises";
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

  it("does not store a token when connection is interrupted", async () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
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
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
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
        }))),
      },
    });
    expect(result.hosts).toEqual(["claude"]);
    expect(store.set).toHaveBeenCalledWith(token);
    const persisted = await readFile(configPath, "utf8");
    expect(persisted).toContain("https://artifacts.example.test/");
    expect(persisted).not.toContain(token);
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
});
