import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installProjectHost } from "../src/hosts/project-hosts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "artifactpass-project-host-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const marketplaceSource = join(root, "portable", "marketplace");
  const pluginRoot = join(marketplaceSource, "plugins", "artifactpass");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(join(pluginRoot, "dist"), { recursive: true }),
    mkdir(join(pluginRoot, "skills", "share-artifact"), { recursive: true }),
    mkdir(join(pluginRoot, "skills", "read-shared-artifact"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, "dist", "cli.mjs"), "export {};\n"),
    writeFile(join(pluginRoot, "skills", "share-artifact", "SKILL.md"), "share\n"),
    writeFile(join(pluginRoot, "skills", "read-shared-artifact", "SKILL.md"), "read\n"),
  ]);
  return { workspaceRoot, marketplaceSource, pluginRoot };
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

describe("project-scoped MCP hosts", () => {
  it.each([
    ["gemini", ".gemini/settings.json", ".gemini/skills", "mcpServers", false],
    ["kimi", ".kimi-code/mcp.json", ".kimi-code/skills", "mcpServers", false],
    ["cursor", ".cursor/mcp.json", ".cursor/skills", "mcpServers", false],
    ["vscode", ".vscode/mcp.json", ".github/skills", "servers", true],
    ["antigravity", ".agents/mcp_config.json", ".agents/skills", "mcpServers", false],
  ] as const)("installs %s MCP and shared skills in the current project", async (
    host,
    relativeConfig,
    relativeSkills,
    collectionName,
    includesType,
  ) => {
    const { workspaceRoot, marketplaceSource, pluginRoot } = await fixture();

    await installProjectHost(host, workspaceRoot, marketplaceSource);

    const config = await readJson(join(workspaceRoot, relativeConfig));
    const collection = config[collectionName] as Record<string, Record<string, unknown>>;
    expect(collection.artifactpass).toEqual({
      ...(includesType ? { type: "stdio" } : {}),
      command: process.execPath,
      args: [join(pluginRoot, "dist", "cli.mjs")],
    });
    await expect(readFile(
      join(workspaceRoot, relativeSkills, "share-artifact", "SKILL.md"),
      "utf8",
    )).resolves.toBe("share\n");
    await expect(readFile(
      join(workspaceRoot, relativeSkills, "read-shared-artifact", "SKILL.md"),
      "utf8",
    )).resolves.toBe("read\n");
  });

  it("preserves unrelated MCP servers and restores exact prior files on rollback", async () => {
    const { workspaceRoot, marketplaceSource } = await fixture();
    const configPath = join(workspaceRoot, ".cursor", "mcp.json");
    const skillPath = join(workspaceRoot, ".cursor", "skills", "share-artifact", "SKILL.md");
    await Promise.all([
      mkdir(join(workspaceRoot, ".cursor"), { recursive: true }),
      mkdir(join(workspaceRoot, ".cursor", "skills", "share-artifact"), { recursive: true }),
    ]);
    const previousConfig = '{\n  "mcpServers": { "existing": { "url": "https://example.test" } }\n}\n';
    await Promise.all([
      writeFile(configPath, previousConfig),
      writeFile(skillPath, "previous skill\n"),
    ]);

    const installation = await installProjectHost("cursor", workspaceRoot, marketplaceSource);
    const installed = await readJson(configPath);
    expect(installed.mcpServers).toMatchObject({
      existing: { url: "https://example.test" },
      artifactpass: expect.any(Object),
    });

    await installation.rollback();

    await expect(readFile(configPath, "utf8")).resolves.toBe(previousConfig);
    await expect(readFile(skillPath, "utf8")).resolves.toBe("previous skill\n");
  });

  it("removes files and directories created by a rolled-back installation", async () => {
    const { workspaceRoot, marketplaceSource } = await fixture();
    const installation = await installProjectHost("gemini", workspaceRoot, marketplaceSource);

    await installation.rollback();

    await expect(access(join(workspaceRoot, ".gemini"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite malformed project MCP configuration", async () => {
    const { workspaceRoot, marketplaceSource } = await fixture();
    const configPath = join(workspaceRoot, ".gemini", "settings.json");
    await mkdir(join(workspaceRoot, ".gemini"), { recursive: true });
    await writeFile(configPath, "not json\n");

    await expect(installProjectHost("gemini", workspaceRoot, marketplaceSource))
      .rejects.toThrow("Gemini CLI MCP configuration is not valid JSON");
    await expect(readFile(configPath, "utf8")).resolves.toBe("not json\n");
  });

  it("preserves comments and trailing commas in VS Code MCP configuration", async () => {
    const { workspaceRoot, marketplaceSource } = await fixture();
    const configPath = join(workspaceRoot, ".vscode", "mcp.json");
    await mkdir(join(workspaceRoot, ".vscode"), { recursive: true });
    await writeFile(configPath, '{\n  // Keep this server.\n  "servers": {\n    "existing": { "url": "https://example.test" },\n  },\n}\n');

    await installProjectHost("vscode", workspaceRoot, marketplaceSource);

    const installed = await readFile(configPath, "utf8");
    expect(installed).toContain("// Keep this server.");
    expect(installed).toContain('"existing"');
    expect(installed).toContain('"artifactpass"');
  });

  it.skipIf(process.platform === "win32")("refuses project config paths that escape through a symlink", async () => {
    const { workspaceRoot, marketplaceSource } = await fixture();
    const outside = join(workspaceRoot, "..", "outside");
    await mkdir(outside);
    await symlink(outside, join(workspaceRoot, ".cursor"));

    await expect(installProjectHost("cursor", workspaceRoot, marketplaceSource))
      .rejects.toThrow("Agent configuration paths cannot contain symbolic links");
    await expect(access(join(outside, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
