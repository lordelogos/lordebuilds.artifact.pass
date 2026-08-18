import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const releaseRoot = resolve(repositoryRoot, "release");
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const version = manifest.version;
const setupManifest = JSON.parse(await readFile(
  resolve(repositoryRoot, "packages/setup-cli/package.json"),
  "utf8",
));
const pluginManifest = JSON.parse(await readFile(
  resolve(repositoryRoot, "plugins/artifactpass/plugin-metadata.json"),
  "utf8",
));

const releaseIdentities = [
  ["root package", manifest.name, manifest.version],
  ["setup package", setupManifest.name, setupManifest.version],
  ["plugin", pluginManifest.name, pluginManifest.version],
];
for (const [label, name, candidateVersion] of releaseIdentities) {
  if (name !== "artifactpass") {
    throw new Error(`${label} must be named artifactpass; received ${name}.`);
  }
  if (candidateVersion !== version) {
    throw new Error(`${label} version ${candidateVersion} does not match ${version}.`);
  }
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
execFileSync(
  "pnpm",
  ["--dir", "packages/setup-cli", "pack", "--pack-destination", releaseRoot],
  { cwd: repositoryRoot, stdio: "inherit" },
);

const pluginArchive = resolve(releaseRoot, `artifactpass-plugin-${version}.tar.gz`);
execFileSync("tar", [
  "-czf", pluginArchive,
  ".claude-plugin", ".codex-plugin", ".mcp.json", "dist", "plugin-metadata.json", "skills",
  "-C", repositoryRoot, "LICENSE",
], { cwd: resolve(repositoryRoot, "plugins/artifactpass") });

const artifacts = (await readdir(releaseRoot))
  .filter((name) => name.endsWith(".tgz") || name.endsWith(".tar.gz"))
  .sort();
const expectedArtifacts = [
  `artifactpass-${version}.tgz`,
  `artifactpass-plugin-${version}.tar.gz`,
].sort();
if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts)) {
  throw new Error(`Release artifacts do not match the expected ArtifactPass set: ${artifacts.join(", ")}.`);
}
if (artifacts.some((artifact) => artifact.includes("artifact-share"))) {
  throw new Error("Legacy Artifact Share archive names are not allowed in this release.");
}
const checksums = [];
const artifactManifest = [];
for (const artifact of artifacts) {
  const digest = createHash("sha256").update(await readFile(resolve(releaseRoot, artifact))).digest("hex");
  checksums.push(`${digest}  ${artifact}`);
  artifactManifest.push({ filename: artifact, sha256: digest });
}
await writeFile(resolve(releaseRoot, "checksums.txt"), `${checksums.join("\n")}\n`);
await writeFile(resolve(releaseRoot, "manifest.json"), `${JSON.stringify({
  manifest_version: 1,
  product: "ArtifactPass",
  version,
  git_commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
  packages: {
    setup: { name: setupManifest.name, version: setupManifest.version },
    plugin: { name: pluginManifest.name, version: pluginManifest.version },
  },
  artifacts: artifactManifest,
  preserved_production_identifiers: {
    worker: "lordebuilds-artifacts-share",
    d1: "lordebuilds-artifacts-share",
    r2: "lordebuilds-artifacts-share",
    health_service: "lordebuilds.artifacts.share",
  },
}, null, 2)}\n`);
process.stdout.write(`Built ${artifacts.length} release artifacts for ${version}.\n`);
