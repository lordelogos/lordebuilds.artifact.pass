import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const pluginRoot = resolve(repositoryRoot, "plugins/artifactpass");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));

describe("dual-host plugin package", () => {
  test("generated files match canonical metadata and the bundled bridge", () => {
    expect(() => execFileSync("node", ["scripts/build-plugin.mjs", "--check"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    })).not.toThrow();
    expect(readFileSync(resolve(pluginRoot, "dist/cli.mjs")).subarray(0, 19).toString()).toContain("#!/usr/bin/env node");
  });

  test("both host manifests expose the same skills and shared MCP runtime", () => {
    const codex = readJson("plugins/artifactpass/.codex-plugin/plugin.json");
    const claude = readJson("plugins/artifactpass/.claude-plugin/plugin.json");
    expect(codex.name).toBe("artifactpass");
    expect(claude.name).toBe(codex.name);
    expect(claude.version).toBe(codex.version);
    expect(claude.skills).toBe("./skills/");
    expect(codex.skills).toBe(claude.skills);
    expect(claude.mcpServers).toBe("./.claude-plugin/mcp.json");
    expect(codex.mcpServers).toBe("./.mcp.json");
    const claudeMcp = readJson("plugins/artifactpass/.claude-plugin/mcp.json");
    expect(claudeMcp.mcpServers.artifactpass.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs",
    ]);
  });

  test("marketplaces resolve the same in-repository plugin", () => {
    const codex = readJson(".agents/plugins/marketplace.json");
    const claude = readJson(".claude-plugin/marketplace.json");
    expect(codex.name).toBe("artifactpass");
    expect(claude.name).toBe(codex.name);
    expect(codex.plugins[0].source.path).toBe("./plugins/artifactpass");
    expect(claude.plugins[0].source).toBe("./plugins/artifactpass");
  });

  test("MCP server runs the bundled bridge without package installation", () => {
    const claudeConfiguration = readJson("plugins/artifactpass/.mcp.json");
    const server = {
      command: "node",
      args: ["./dist/cli.mjs"],
      cwd: ".",
    };
    expect(claudeConfiguration).toEqual({
      mcpServers: {
        artifactpass: server,
      },
    });
  });

  test("bundled bridge does not approve an arbitrary no-config path", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-plugin-root-guard-"));
    const artifactPath = join(root, "outside.md");
    await writeFile(artifactPath, "# Outside\n");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(pluginRoot, "dist/cli.mjs")],
      cwd: pluginRoot,
      env: {
        XDG_CONFIG_HOME: join(root, "empty-config"),
        ARTIFACTPASS_BASE_URL: "http://127.0.0.1:8787",
        ARTIFACTPASS_OPEN_DEVELOPMENT: "1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "artifactpass-bundle-root-guard", version: "0.0.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "publish_artifact",
        arguments: { path: artifactPath },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("outside the approved workspace roots") }),
      ]));
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skills stay within the supported product contract", () => {
    const skillText = [
      "plugins/artifactpass/skills/share-artifact/SKILL.md",
      "plugins/artifactpass/skills/read-shared-artifact/SKILL.md",
    ].map((path) => readFileSync(resolve(repositoryRoot, path), "utf8")).join("\n").toLowerCase();
    expect(skillText).toContain("exact expiry cutoff");
    expect(skillText).toContain("exact source");
    expect(skillText).toContain("human-only");
    expect(skillText).toContain("canonical source");
    expect(skillText).toContain("bearer capability");
    expect(skillText).toContain("next_cursor");
    expect(skillText).not.toContain("`done`");
    expect(skillText).not.toContain("supported content type");
    for (const unsupportedClaim of ["permanent history", "paid capabilities", "paid features"]) {
      const matchingLines = skillText.split("\n").filter((line) => line.includes(unsupportedClaim));
      expect(matchingLines.every((line) => line.includes("do not claim"))).toBe(true);
    }
    expect(skillText).not.toMatch(/perfect extraction is supported|all file formats are supported/);
  });
});
