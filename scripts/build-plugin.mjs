import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repositoryRoot, "plugins/artifact-share");
const metadata = JSON.parse(await readFile(resolve(pluginRoot, "plugin-metadata.json"), "utf8"));
const checkOnly = process.argv.includes("--check");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const generated = new Map([
  [resolve(pluginRoot, ".codex-plugin/plugin.json"), json({
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    author: { name: metadata.developerName },
    homepage: metadata.homepage,
    skills: "./skills/",
    interface: {
      displayName: metadata.displayName,
      shortDescription: metadata.description,
      longDescription: metadata.longDescription,
      developerName: metadata.developerName,
      category: "Productivity",
      capabilities: ["MCP server", "Skills"],
      defaultPrompt: "Share a supported local artifact or read an Artifact Share link.",
    },
    mcpServers: "./.mcp.json",
  })],
  [resolve(pluginRoot, ".claude-plugin/plugin.json"), json({
    name: metadata.name,
    version: metadata.version,
    displayName: metadata.displayName,
    description: metadata.description,
    author: { name: metadata.developerName },
    homepage: metadata.homepage,
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  })],
  [resolve(pluginRoot, ".mcp.json"), json({
    mcpServers: {
      "artifact-share": {
        command: "node",
        args: ["./dist/cli.mjs"],
        cwd: ".",
      },
    },
  })],
  [resolve(repositoryRoot, ".agents/plugins/marketplace.json"), json({
    name: metadata.marketplaceName,
    interface: { displayName: metadata.marketplaceDisplayName },
    plugins: [{
      name: metadata.name,
      source: { source: "local", path: `./plugins/${metadata.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  })],
  [resolve(repositoryRoot, ".claude-plugin/marketplace.json"), json({
    name: metadata.marketplaceName,
    owner: { name: metadata.developerName },
    metadata: { description: metadata.longDescription },
    plugins: [{
      name: metadata.name,
      source: `./plugins/${metadata.name}`,
      description: metadata.description,
      category: "Productivity",
    }],
  })],
]);

const stale = [];
for (const [path, expected] of generated) {
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    actual = undefined;
  }
  if (actual === expected) continue;
  if (checkOnly) {
    stale.push(path);
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected);
}

const bridgeSource = resolve(repositoryRoot, "packages/agent-bridge/dist/cli.mjs");
const bridgeTarget = resolve(pluginRoot, "dist/cli.mjs");
if (!checkOnly) {
  await mkdir(dirname(bridgeTarget), { recursive: true });
  await copyFile(bridgeSource, bridgeTarget);
} else {
  const [source, target] = await Promise.all([
    readFile(bridgeSource),
    readFile(bridgeTarget).catch(() => undefined),
  ]);
  if (target === undefined || !source.equals(target)) stale.push(bridgeTarget);
}

if (stale.length > 0) {
  process.stderr.write(`Generated plugin files are stale:\n${stale.map((path) => `- ${path}`).join("\n")}\n`);
  process.exitCode = 1;
}
