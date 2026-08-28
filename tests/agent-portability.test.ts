import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const pluginRoot = resolve(repositoryRoot, "plugins/artifactpass");

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

const frontmatter = (source: string): Readonly<Record<string, string>> => {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (match?.[1] === undefined) throw new Error("SKILL.md frontmatter is missing");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Malformed SKILL.md frontmatter line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
};

describe("portable agent package", () => {
  it("exposes one vendor-neutral MCP server configuration", async () => {
    const configuration = await readJson(resolve(pluginRoot, ".mcp.json"));
    expect(configuration).toEqual({
      mcpServers: {
        artifactpass: {
          command: "node",
          args: ["./dist/cli.mjs"],
          cwd: ".",
        },
      },
    });
  });

  it("ships Agent Skills specification-compatible skill directories", async () => {
    const skillsRoot = resolve(pluginRoot, "skills");
    const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(skillsRoot, entry.name));

    expect(skillDirectories).toHaveLength(2);
    for (const directory of skillDirectories) {
      const source = await readFile(resolve(directory, "SKILL.md"), "utf8");
      const metadata = frontmatter(source);
      expect(metadata.name).toBe(basename(directory));
      expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(metadata.name?.length).toBeLessThanOrEqual(64);
      expect(metadata.description?.length).toBeGreaterThan(0);
      expect(metadata.description?.length).toBeLessThanOrEqual(1024);
      expect(source).not.toMatch(/\b(?:codex|claude)\b/iu);
      expect(source).toMatch(/\b(?:publish_artifact|read_artifact)\b/u);
    }
  });

  it("defines a complete default handoff independent of ecosystem syntax", async () => {
    const source = await readFile(
      resolve(pluginRoot, "skills/share-artifact/SKILL.md"),
      "utf8",
    );

    expect(source).toMatch(/(?:one hour|3600 seconds)/iu);
    expect(source).toMatch(/format/iu);
    expect(source).toMatch(/size/iu);
    expect(source).toMatch(/checksum|sha-?256/iu);
    expect(source).toMatch(/expir/iu);
    expect(source).toMatch(/final durable artifact/iu);
    expect(source).toMatch(/opt(?: |-)?out/iu);
    expect(source).toMatch(/no (?:declared )?artifact.*(?:quiet|no visible)/isu);
    expect(source).not.toMatch(/slash command|hook syntax|end[- ]of[- ]turn command/iu);
  });

  it("connects from the plugin on first publication without a terminal command or restart", async () => {
    const source = await readFile(
      resolve(pluginRoot, "skills/share-artifact/SKILL.md"),
      "utf8",
    );

    expect(source).toContain("connection_status");
    expect(source).toContain("connect_artifactpass");
    expect(source).toMatch(/same agent session/iu);
    expect(source).not.toMatch(/pnpm dlx artifactpass connect/iu);
    expect(source).not.toMatch(/restart.*(?:approval|connect)/iu);
  });

  it("keeps ecosystem manifests as thin references to the same MCP and skills", async () => {
    const [codexManifest, claudeManifest, claudeMcp] = await Promise.all([
      readJson(resolve(pluginRoot, ".codex-plugin/plugin.json")),
      readJson(resolve(pluginRoot, ".claude-plugin/plugin.json")),
      readJson(resolve(pluginRoot, ".claude-plugin/mcp.json")),
    ]);

    for (const manifest of [codexManifest, claudeManifest]) {
      expect(manifest.skills).toBe("./skills/");
      expect(JSON.stringify(manifest)).not.toContain("dist/cli.mjs");
    }

    expect(codexManifest.mcpServers).toBe("./.mcp.json");
    expect(claudeManifest.mcpServers).toBe("./.claude-plugin/mcp.json");
    expect(claudeMcp).toEqual({
      mcpServers: {
        artifactpass: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"],
        },
      },
    });
  });
});
