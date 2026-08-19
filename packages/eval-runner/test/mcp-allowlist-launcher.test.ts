import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { LocalEvalEnvironment } from "../src/local-environment";
import { configureModelHost } from "../src/model-host";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("scrubbed MCP launcher allowlist", () => {
  it("places the explicit allowlist in both Codex and Claude wrapped MCP registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-mcp-config-"));
    const mcpConfigPath = join(root, "mcp.json");
    const launcherPath = join(root, "scrubbed-mcp-launcher.mjs");
    const pluginRoot = join(root, "plugin");
    const environment: LocalEvalEnvironment = {
      runId: "test",
      root,
      baseUrl: new URL("http://127.0.0.1:8787"),
      stateRoot: join(root, "state"),
      configPath: join(root, "config.json"),
      receiptRoot: join(root, "receipts"),
      workspaces: { agentA: join(root, "agent-a-workspace"), agentB: join(root, "agent-b-workspace") },
      homes: { agentA: join(root, "agent-a-home"), agentB: join(root, "agent-b-home") },
      controlToken: "control",
      pdfPrivateKey: "private",
      stop: async () => undefined,
    };
    await Promise.all([
      mkdir(join(pluginRoot, "skills"), { recursive: true }),
      mkdir(environment.homes.agentA, { recursive: true }),
      mkdir(environment.homes.agentB, { recursive: true }),
    ]);
    await writeFile(mcpConfigPath, `${JSON.stringify({
      mcpServers: { artifactpass: { command: process.execPath, args: ["bridge.mjs"] } },
    })}\n`);

    try {
      await configureModelHost({
        host: "codex",
        agent: "agent-a",
        environment,
        mcpConfigPath,
        launcherPath,
        allowedTools: ["publish_artifact"],
      });
      const codexConfiguration = await readFile(join(environment.homes.agentA, "config.toml"), "utf8");
      expect(codexConfiguration).toContain("--allowed-tools");
      expect(codexConfiguration).toContain("publish_artifact");
      expect(codexConfiguration).not.toContain("read_artifact");

      const claude = await configureModelHost({
        host: "claude",
        agent: "agent-b",
        environment,
        mcpConfigPath,
        launcherPath,
        allowedTools: ["read_artifact"],
      });
      const claudeConfiguration = JSON.parse(await readFile(claude.mcpConfigPath, "utf8")) as {
        readonly mcpServers: { readonly artifactpass: { readonly args: readonly string[] } };
      };
      expect(claudeConfiguration.mcpServers.artifactpass.args).toEqual([
        launcherPath,
        "--allowed-tools",
        JSON.stringify(["read_artifact"]),
        "--",
        process.execPath,
        "bridge.mjs",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advertises exactly selected tools and rejects direct calls to unselected tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-mcp-allowlist-"));
    const launcherPath = join(root, "scrubbed-mcp-launcher.mjs");
    const evidencePath = join(root, "calls.txt");
    await build({
      entryPoints: [join(packageRoot, "src/scrubbed-mcp-launcher.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: launcherPath,
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        launcherPath,
        "--allowed-tools",
        JSON.stringify(["publish_artifact"]),
        "--",
        process.execPath,
        join(packageRoot, "test/fixtures/mcp-two-tool-server.mjs"),
      ],
      env: {
        PATH: process.env.PATH ?? "",
        ARTIFACTPASS_CONFIG_PATH: evidencePath,
      },
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const client = new Client({ name: "artifactpass-allowlist-test", version: "1.0.0" });

    try {
      await client.connect(transport).catch((error: unknown) => {
        throw new Error(`Launcher connection failed: ${error instanceof Error ? error.message : "unknown error"}\n${stderr.join("")}`);
      });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["publish_artifact"]);

      await client.request({
        method: "tools/call",
        params: { name: "publish_artifact", arguments: {} },
      }, z.unknown());
      await expect(client.request({
        method: "tools/call",
        params: { name: "read_artifact", arguments: {} },
      }, z.unknown())).rejects.toThrow(/not allowed/u);

      expect(await readFile(evidencePath, "utf8")).toBe("publish_artifact\n");
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
