import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const releaseRoot = resolve(repositoryRoot, "release");
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const version = manifest.version;

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
execFileSync(
  "pnpm",
  ["--dir", "packages/setup-cli", "pack", "--pack-destination", releaseRoot],
  { cwd: repositoryRoot, stdio: "inherit" },
);

const pluginArchive = resolve(releaseRoot, `artifact-share-plugin-${version}.tar.gz`);
execFileSync("tar", [
  "-czf", pluginArchive,
  ".claude-plugin", ".codex-plugin", ".mcp.json", "dist", "plugin-metadata.json", "skills",
  "-C", repositoryRoot, "LICENSE",
], { cwd: resolve(repositoryRoot, "plugins/artifact-share") });

const artifacts = (await readdir(releaseRoot))
  .filter((name) => name.endsWith(".tgz") || name.endsWith(".tar.gz"))
  .sort();
const checksums = [];
for (const artifact of artifacts) {
  const digest = createHash("sha256").update(await readFile(resolve(releaseRoot, artifact))).digest("hex");
  checksums.push(`${digest}  ${artifact}`);
}
await writeFile(resolve(releaseRoot, "checksums.txt"), `${checksums.join("\n")}\n`);
process.stdout.write(`Built ${artifacts.length} release artifacts for ${version}.\n`);
