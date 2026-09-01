import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFile(resolve(repositoryRoot, path), "utf8");
const fail = (message) => {
  throw new Error(`Distribution security verification failed: ${message}`);
};

const [rootText, setupText, pluginText, workspace, candidateWorkflow, releaseWorkflow] = await Promise.all([
  read("package.json"),
  read("packages/setup-cli/package.json"),
  read("plugins/artifactpass/plugin-metadata.json"),
  read("pnpm-workspace.yaml"),
  read(".github/workflows/publish-candidate.yml"),
  read(".github/workflows/release.yml"),
]);
const root = JSON.parse(rootText);
const setup = JSON.parse(setupText);
const plugin = JSON.parse(pluginText);

if (root.version !== setup.version || setup.version !== plugin.version) {
  fail("root, setup package, and plugin versions must match");
}
if (!/^\d+\.\d+\.\d+-rc\.\d+$/u.test(setup.version)) {
  fail("the candidate must use an exact release-candidate version");
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
if (!candidateWorkflow.includes("npm publish \"$package_archive\" --tag rc --access public --provenance")) {
  fail("candidate publishing does not explicitly request npm provenance");
}
if (!candidateWorkflow.includes("git merge-base --is-ancestor HEAD origin/main")) {
  fail("candidate tags are not restricted to commits reachable from main");
}
if (!releaseWorkflow.includes("actions/attest@")) fail("release artifacts are not attested");

process.stdout.write(`Distribution security verification passed for ArtifactPass ${setup.version}.\n`);
