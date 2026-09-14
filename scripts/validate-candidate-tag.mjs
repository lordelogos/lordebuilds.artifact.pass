import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = process.cwd();
const releaseTag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
const repositoryVisibility = process.env.REPOSITORY_VISIBILITY ?? "private";

const readJson = async (path) => JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
const git = (...args) => execFileSync("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const fail = (message) => {
  throw new Error(`Candidate tag validation failed: ${message}`);
};

if (!releaseTag) fail("RELEASE_TAG or GITHUB_REF_NAME is required");

const [root, setup, plugin] = await Promise.all([
  readJson("package.json"),
  readJson("packages/setup-cli/package.json"),
  readJson("plugins/artifactpass/plugin-metadata.json"),
]);
const version = setup.version;

if (releaseTag !== `v${version}`) fail(`tag ${releaseTag} does not match package version ${version}`);
if (root.version !== version || plugin.version !== version) fail("root, setup package, and plugin versions do not match");

git("merge-base", "--is-ancestor", "HEAD", "origin/main");

let releaseChannel;
if (/^\d+\.\d+\.\d+-rc\.\d+$/u.test(version)) {
  releaseChannel = "rc";
} else if (/^\d+\.\d+\.\d+$/u.test(version)) {
  releaseChannel = "candidate";
} else {
  fail("only exact RC or stable versions may be published");
}

if (releaseChannel === "candidate") {
  if (repositoryVisibility !== "public") fail("stable candidate publishing requires a public repository");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    fail("stable candidate tag must point to the reviewed tip of main");
  }
}

if (process.env.GITHUB_ENV) {
  await appendFile(process.env.GITHUB_ENV, `release_channel=${releaseChannel}\n`);
}
process.stdout.write(`Candidate tag ${releaseTag} is valid for the ${releaseChannel} channel.\n`);
