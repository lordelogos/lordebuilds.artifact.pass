import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFile(resolve(repositoryRoot, path), "utf8");
const fail = (message) => {
  throw new Error(`Distribution security verification failed: ${message}`);
};

const [
  rootText,
  setupText,
  pluginText,
  workspace,
  candidateWorkflow,
  releaseWorkflow,
  ciWorkflow,
  evalsWorkflow,
] = await Promise.all([
  read("package.json"),
  read("packages/setup-cli/package.json"),
  read("plugins/artifactpass/plugin-metadata.json"),
  read("pnpm-workspace.yaml"),
  read(".github/workflows/publish-candidate.yml"),
  read(".github/workflows/release.yml"),
  read(".github/workflows/ci.yml"),
  read(".github/workflows/evals.yml"),
]);
const root = JSON.parse(rootText);
const setup = JSON.parse(setupText);
const plugin = JSON.parse(pluginText);

if (root.version !== setup.version || setup.version !== plugin.version) {
  fail("root, setup package, and plugin versions must match");
}
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(setup.version)) {
  fail("the candidate must use an exact RC or stable version");
}
if (setup.bin?.artifactpass !== "dist/cli.mjs") fail("the published CLI entrypoint changed");
if (setup.scripts?.preinstall !== undefined || setup.scripts?.install !== undefined || setup.scripts?.postinstall !== undefined) {
  fail("the published package cannot run install lifecycle scripts");
}
if (!/onlyBuiltDependencies:\s*\n\s*- esbuild\s*\n\s*- workerd\s*(?:\n|$)/u.test(workspace)) {
  fail("the reviewed native build dependency allowlist changed");
}
for (const [name, workflow] of [["candidate", candidateWorkflow], ["release", releaseWorkflow]]) {
  if (!workflow.includes("environment: artifactpass-release")) fail(`${name} workflow is not protected by the release environment`);
  if (!workflow.includes("id-token: write")) fail(`${name} workflow cannot create provenance`);
  if (!workflow.includes("pnpm release:check")) fail(`${name} workflow skips the release gate`);
  if (!workflow.includes("pnpm test:packed-install")) fail(`${name} workflow skips the packed install gate`);
}
if (!candidateWorkflow.includes('npm publish "$package_archive" --tag "$release_channel" --access public --provenance')) {
  fail("candidate publishing does not explicitly request npm provenance");
}
if ((candidateWorkflow.match(/node scripts\/validate-candidate-tag\.mjs/gu) ?? []).length !== 2) {
  fail("candidate publishing does not validate the tag both before qualification and immediately before publication");
}
if (!candidateWorkflow.includes("scan-secrets.mjs --history --fetch-remote origin")) {
  fail("candidate publishing does not scan every remote ref before publication");
}
if (!candidateWorkflow.includes("git fetch --no-tags origin main")) {
  fail("candidate publishing does not refresh main immediately before final tag validation");
}
if (!releaseWorkflow.includes("actions/attest@")) fail("release artifacts are not attested");

for (const [name, workflow] of [
  ["CI", ciWorkflow],
  ["evals", evalsWorkflow],
  ["candidate", candidateWorkflow],
  ["release", releaseWorkflow],
]) {
  const actionReferences = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  if (actionReferences.length === 0) fail(`${name} workflow has no auditable actions`);
  for (const reference of actionReferences) {
    if (!/^[^@]+@[0-9a-f]{40}$/u.test(reference)) {
      fail(`${name} workflow action is not commit-pinned: ${reference}`);
    }
  }
}

process.stdout.write(`Distribution security verification passed for ArtifactPass ${setup.version}.\n`);
