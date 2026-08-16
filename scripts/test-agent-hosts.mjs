import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const canonicalRoot = resolve(repositoryRoot, "plugins/artifact-share");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-agent-hosts-"));

const run = async (command, args, environment) => execute(command, args, {
  cwd: repositoryRoot,
  env: { ...process.env, ...environment },
  maxBuffer: 8 * 1024 * 1024,
});

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

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

  process.stdout.write(
    `Agent host conformance passed: Codex and Claude Code installed the same ${files.length}-file portable MCP and Agent Skills package.\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
