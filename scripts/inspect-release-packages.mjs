import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifactpass-release-"));

const fail = (message) => {
  throw new Error(`Release package inspection failed: ${message}`);
};

try {
  execFileSync(
    "pnpm",
    ["--dir", "packages/setup-cli", "pack", "--pack-destination", temporaryRoot],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  const archives = (await readdir(temporaryRoot)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) fail("setup CLI did not produce exactly one tarball");
  const archive = resolve(temporaryRoot, archives[0]);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  const unexpected = entries.filter((entry) =>
    entry !== "package/package.json" &&
    entry !== "package/LICENSE" &&
    !entry.startsWith("package/dist/"));
  if (unexpected.length > 0) fail(`unexpected setup CLI files: ${unexpected.join(", ")}`);
  if (!entries.includes("package/dist/cli.mjs")) fail("setup CLI entrypoint is missing");
  if (!entries.includes("package/dist/deployment/index.js")) fail("Worker deployment bundle is missing");
  if (!entries.includes("package/dist/marketplace/plugins/artifactpass/dist/cli.mjs")) {
    fail("attested plugin bundle is missing from setup CLI");
  }

  const packedManifest = JSON.parse(execFileSync(
    "tar",
    ["-xOzf", archive, "package/package.json"],
    { encoding: "utf8" },
  ));
  if (JSON.stringify(packedManifest).includes("workspace:")) {
    fail("published setup manifest contains a workspace dependency");
  }
  if (
    JSON.stringify(packedManifest.dependencies) !== JSON.stringify({ wrangler: "4.123.0" })
  ) fail("setup CLI runtime dependencies differ from the reviewed manifest");
  if (packedManifest.scripts?.preinstall !== undefined || packedManifest.scripts?.postinstall !== undefined) {
    fail("setup CLI contains an install lifecycle script");
  }

  const pluginRoot = resolve(repositoryRoot, "plugins/artifactpass");
  const pluginFiles = execFileSync("git", ["ls-files", "plugins/artifactpass"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  const allowedPluginPaths = [
    /^plugins\/artifactpass\/\.claude-plugin\/plugin\.json$/u,
    /^plugins\/artifactpass\/\.claude-plugin\/mcp\.json$/u,
    /^plugins\/artifactpass\/\.codex-plugin\/plugin\.json$/u,
    /^plugins\/artifactpass\/\.mcp\.json$/u,
    /^plugins\/artifactpass\/dist\/cli\.mjs$/u,
    /^plugins\/artifactpass\/plugin-metadata\.json$/u,
    /^plugins\/artifactpass\/skills\/[a-z-]+\/SKILL\.md$/u,
  ];
  const unexpectedPlugin = pluginFiles.filter((file) =>
    !allowedPluginPaths.some((pattern) => pattern.test(file)));
  if (unexpectedPlugin.length > 0) fail(`unexpected plugin files: ${unexpectedPlugin.join(", ")}`);
  if (!(await readFile(resolve(pluginRoot, "dist/cli.mjs"))).length) fail("plugin bridge is empty");
  const packedPluginBridge = execFileSync(
    "tar",
    ["-xOzf", archive, "package/dist/marketplace/plugins/artifactpass/dist/cli.mjs"],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const canonicalPluginBridge = await readFile(resolve(pluginRoot, "dist/cli.mjs"));
  if (!packedPluginBridge.equals(canonicalPluginBridge)) {
    fail("setup CLI plugin bridge differs from the attested canonical plugin");
  }

  process.stdout.write(
    `Release package inspection passed (${entries.length} setup entries; ${pluginFiles.length} plugin files).\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
