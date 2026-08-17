import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const pluginRoot = resolve(repositoryRoot, "plugins/artifact-share");
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
    const codex = readJson("plugins/artifact-share/.codex-plugin/plugin.json");
    const claude = readJson("plugins/artifact-share/.claude-plugin/plugin.json");
    expect(codex.name).toBe("artifact-share");
    expect(claude.name).toBe(codex.name);
    expect(claude.version).toBe(codex.version);
    expect(claude.skills).toBe("./skills/");
    expect(codex.skills).toBe(claude.skills);
    expect(claude.mcpServers).toBe("./.claude-plugin/mcp.json");
    expect(codex.mcpServers).toBe("./.mcp.json");
    const claudeMcp = readJson("plugins/artifact-share/.claude-plugin/mcp.json");
    expect(claudeMcp.mcpServers["artifact-share"].args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs",
    ]);
  });

  test("marketplaces resolve the same in-repository plugin", () => {
    const codex = readJson(".agents/plugins/marketplace.json");
    const claude = readJson(".claude-plugin/marketplace.json");
    expect(codex.name).toBe("lordebuilds-artifacts");
    expect(claude.name).toBe(codex.name);
    expect(codex.plugins[0].source.path).toBe("./plugins/artifact-share");
    expect(claude.plugins[0].source).toBe("./plugins/artifact-share");
  });

  test("MCP server runs the bundled bridge without package installation", () => {
    const claudeConfiguration = readJson("plugins/artifact-share/.mcp.json");
    const server = {
      command: "node",
      args: ["./dist/cli.mjs"],
      cwd: ".",
    };
    expect(claudeConfiguration).toEqual({
      mcpServers: {
        "artifact-share": server,
      },
    });
  });

  test("skills stay within the supported product contract", () => {
    const skillText = [
      "plugins/artifact-share/skills/share-artifact/SKILL.md",
      "plugins/artifact-share/skills/read-shared-artifact/SKILL.md",
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
