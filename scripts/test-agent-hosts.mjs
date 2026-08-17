import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { sourceSha256 } from "./publication-commitment.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const canonicalRoot = resolve(repositoryRoot, "plugins/artifact-share");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-agent-hosts-"));

const run = async (command, args, environment) => execute(command, args, {
  cwd: repositoryRoot,
  env: { ...process.env, ...environment },
  maxBuffer: 8 * 1024 * 1024,
});

const digest = async (path) => sourceSha256(await readFile(path));

const portableFiles = async () => {
  const entries = await readdir(canonicalRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(canonicalRoot, resolve(entry.parentPath, entry.name)))
    .filter((path) =>
      path === ".mcp.json" ||
      path === "plugin-metadata.json" ||
      path === "dist/cli.mjs" ||
      /^skills\/[a-z0-9-]+\/SKILL\.md$/u.test(path)
    )
    .sort();
};

const assertPortableBytes = async (host, installedRoot, files) => {
  for (const file of files) {
    const [canonical, installed] = await Promise.all([
      digest(resolve(canonicalRoot, file)),
      digest(resolve(installedRoot, file)),
    ]);
    if (canonical !== installed) {
      throw new Error(`${host} installed different portable package bytes for ${file}`);
    }
  }
};

const assertRuntimeConformance = async (host, installedRoot) => {
  const configuration = JSON.parse(await readFile(resolve(installedRoot, ".mcp.json"), "utf8"));
  const server = configuration.mcpServers?.["artifact-share"];
  if (server?.command !== "node" || !Array.isArray(server.args)) {
    throw new Error(`${host} installed an invalid Artifact Share MCP configuration`);
  }
  const command = process.execPath;
  const args = server.args.map((argument) =>
    argument.startsWith(".") ? resolve(installedRoot, argument) : argument
  );
  const unrelatedWorkingDirectory = resolve(temporaryRoot, `${host.toLowerCase().replaceAll(" ", "-")}-cwd`);
  await mkdir(unrelatedWorkingDirectory);
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: unrelatedWorkingDirectory,
    env: {
      ARTIFACT_SHARE_BASE_URL: "https://artifacts.example.test",
      ARTIFACT_SHARE_TOKEN: `as_${"t".repeat(43)}`,
      ARTIFACT_SHARE_WORKSPACE_ROOTS: temporaryRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "artifact-share-host-conformance", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(["publish_artifact", "read_artifact"])) {
      throw new Error(`${host} did not negotiate the portable Artifact Share MCP tools`);
    }
    const skillEntries = await readdir(resolve(installedRoot, "skills"), { withFileTypes: true });
    const discoveredSkills = skillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    if (JSON.stringify(discoveredSkills) !== JSON.stringify(["read-shared-artifact", "share-artifact"])) {
      throw new Error(`${host} did not expose the portable Agent Skills`);
    }
  } finally {
    await client.close();
  }
};

try {
  const codexHome = resolve(temporaryRoot, "codex");
  await mkdir(codexHome);
  const codexEnvironment = { CODEX_HOME: codexHome };
  await run("codex", ["plugin", "marketplace", "add", repositoryRoot, "--json"], codexEnvironment);
  const codexInstall = JSON.parse((await run(
    "codex",
    ["plugin", "add", "artifact-share@lordebuilds-artifacts", "--json"],
    codexEnvironment,
  )).stdout);
  if (typeof codexInstall.installedPath !== "string") {
    throw new Error("Codex did not report an installed plugin path");
  }

  const claudeHome = resolve(temporaryRoot, "claude");
  await mkdir(claudeHome);
  const claudeEnvironment = { CLAUDE_CONFIG_DIR: claudeHome };
  await run(
    "claude",
    ["plugin", "marketplace", "add", repositoryRoot, "--scope", "user"],
    claudeEnvironment,
  );
  await run(
    "claude",
    ["plugin", "install", "artifact-share@lordebuilds-artifacts", "--scope", "user"],
    claudeEnvironment,
  );
  const claudePlugins = JSON.parse((await run(
    "claude",
    ["plugin", "list", "--json"],
    claudeEnvironment,
  )).stdout);
  const claudeInstall = claudePlugins.find((plugin) =>
    plugin.id === "artifact-share@lordebuilds-artifacts"
  );
  if (typeof claudeInstall?.installPath !== "string") {
    throw new Error("Claude Code did not report an installed plugin path");
  }

  const files = await portableFiles();
  await Promise.all([
    assertPortableBytes("Codex", codexInstall.installedPath, files),
    assertPortableBytes("Claude Code", claudeInstall.installPath, files),
  ]);
  await Promise.all([
    assertRuntimeConformance("Codex", codexInstall.installedPath),
    assertRuntimeConformance("Claude Code", claudeInstall.installPath),
  ]);

  process.stdout.write(
    `Agent host conformance passed: Codex and Claude Code installed and launched the same ${files.length}-file portable MCP and Agent Skills package.\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
