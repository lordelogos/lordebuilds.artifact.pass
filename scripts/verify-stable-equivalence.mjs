import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifactpass-stable-equivalence-"));
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}
const referenceVersion = argumentsByName.get("--reference");
let candidateArchive = argumentsByName.get("--candidate");
if (!referenceVersion) throw new Error("--reference is required");

const allowedVersionFiles = new Set([
  "dist/cli.mjs",
  "dist/deployment/index.js",
  "dist/deployment/wrangler-template.json",
  "dist/marketplace/plugins/artifactpass/.claude-plugin/plugin.json",
  "dist/marketplace/plugins/artifactpass/.codex-plugin/plugin.json",
  "dist/marketplace/plugins/artifactpass/plugin-metadata.json",
  "package.json",
]);

const filesBelow = async (root, directory = root) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [relative(root, path)];
  }));
  return nested.flat().sort();
};
const digest = (bytes) => createHash("sha512").update(bytes).digest("base64");
const normalizeVersion = (bytes, version) => Buffer.from(
  bytes.toString("utf8").replaceAll(version, "<ARTIFACTPASS_VERSION>"),
  "utf8",
);
const normalizeWranglerTemplate = (bytes) => {
  const template = JSON.parse(bytes.toString("utf8"));
  template.configPath = "<BUILD_REPOSITORY>/apps/artifact-service/wrangler.jsonc";
  template.userConfigPath = "<BUILD_REPOSITORY>/apps/artifact-service/wrangler.jsonc";
  return Buffer.from(JSON.stringify(template), "utf8");
};
const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
};
const normalizePackageManifest = (bytes) => {
  const manifest = JSON.parse(bytes.toString("utf8"));
  manifest.version = "<ARTIFACTPASS_VERSION>";
  return Buffer.from(JSON.stringify(canonicalJson(manifest)), "utf8");
};

try {
  if (!candidateArchive) {
    const archiveDirectory = resolve(temporaryRoot, "candidate-archive");
    await mkdir(archiveDirectory);
    await execute("pnpm", ["--dir", "packages/setup-cli", "pack", "--pack-destination", archiveDirectory], {
      cwd: repositoryRoot,
    });
    const archives = (await readdir(archiveDirectory)).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) throw new Error("Expected exactly one stable candidate archive");
    candidateArchive = resolve(archiveDirectory, archives[0]);
  } else {
    candidateArchive = resolve(candidateArchive);
  }

  const candidateManifest = JSON.parse(await readFile(resolve(repositoryRoot, "packages/setup-cli/package.json"), "utf8"));
  const metadataResponse = await fetch(`https://registry.npmjs.org/artifactpass/${referenceVersion}`);
  if (!metadataResponse.ok) throw new Error(`Could not resolve artifactpass@${referenceVersion}`);
  const metadata = await metadataResponse.json();
  const referenceBytes = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
  const actualReferenceIntegrity = `sha512-${digest(referenceBytes)}`;
  if (actualReferenceIntegrity !== metadata.dist.integrity) throw new Error("Reference registry integrity mismatch");

  const referenceArchive = resolve(temporaryRoot, "reference.tgz");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(referenceArchive, referenceBytes);
  const referenceDirectory = resolve(temporaryRoot, "reference");
  const candidateDirectory = resolve(temporaryRoot, "candidate");
  await Promise.all([mkdir(referenceDirectory), mkdir(candidateDirectory)]);
  await Promise.all([
    execute("tar", ["-xzf", referenceArchive, "-C", referenceDirectory]),
    execute("tar", ["-xzf", candidateArchive, "-C", candidateDirectory]),
  ]);
  const referenceRoot = resolve(referenceDirectory, "package");
  const candidateRoot = resolve(candidateDirectory, "package");
  const [referenceFiles, candidateFiles] = await Promise.all([
    filesBelow(referenceRoot),
    filesBelow(candidateRoot),
  ]);
  if (JSON.stringify(referenceFiles) !== JSON.stringify(candidateFiles)) {
    throw new Error("Stable candidate file set differs from the qualified RC");
  }

  for (const path of referenceFiles) {
    const [referenceFile, candidateFile] = await Promise.all([
      readFile(resolve(referenceRoot, path)),
      readFile(resolve(candidateRoot, path)),
    ]);
    let equivalent;
    if (path === "package.json") {
      equivalent = normalizePackageManifest(referenceFile).equals(normalizePackageManifest(candidateFile));
    } else if (path === "dist/deployment/wrangler-template.json") {
      equivalent = normalizeWranglerTemplate(referenceFile).equals(normalizeWranglerTemplate(candidateFile));
    } else if (allowedVersionFiles.has(path)) {
      equivalent = normalizeVersion(referenceFile, referenceVersion).equals(normalizeVersion(candidateFile, candidateManifest.version));
    } else {
      equivalent = referenceFile.equals(candidateFile);
    }
    if (!equivalent) throw new Error(`Stable candidate differs from the qualified RC at ${path}`);
  }

  const candidateBytes = await readFile(candidateArchive);
  process.stdout.write([
    `Stable artifactpass@${candidateManifest.version} is byte-equivalent to artifactpass@${referenceVersion} after exact version normalization.`,
    `Reference integrity: ${metadata.dist.integrity}`,
    `Candidate integrity: sha512-${digest(candidateBytes)}`,
    "",
  ].join("\n"));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
