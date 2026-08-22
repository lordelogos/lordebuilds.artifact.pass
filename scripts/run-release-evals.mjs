import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const trials = Number(argument("--trials") ?? "20");
const initialBudget = Number(argument("--maximum-budget-usd"));
if (!Number.isInteger(trials) || trials !== 20) {
  throw new Error("ArtifactPass release evidence requires exactly 20 trials per blocking cohort");
}
if (!Number.isFinite(initialBudget) || initialBudget <= 0) {
  throw new Error("ArtifactPass release evidence requires a positive --maximum-budget-usd");
}

const repositoryRoot = resolve(process.cwd());
const evalRunnerRoot = resolve(repositoryRoot, "packages/eval-runner/dist");
const runJson = (entry, args) => {
  const execution = spawnSync(process.execPath, [resolve(evalRunnerRoot, entry), ...args], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (execution.error !== undefined) throw execution.error;
  if (execution.status !== 0) throw new Error(`${entry} failed with exit ${execution.status ?? "signal"}`);
  return JSON.parse(execution.stdout);
};

const policy = JSON.parse(await readFile(resolve(repositoryRoot, "evals/release-policy.json"), "utf8"));
const uncalibrated = policy.cohorts
  .filter((cohort) => cohort.blocking && cohort.evaluation === "behavioral_threshold" && !cohort.calibrated)
  .map((cohort) => cohort.id);
if (uncalibrated.length > 0) {
  throw new Error(`Release thresholds are not calibrated: ${uncalibrated.join(", ")}`);
}

const matrix = runJson("matrix-cli.mjs", []);
if (matrix.release_eligible !== true) {
  const blockers = matrix.pairs
    .filter((pair) => pair.blocking && pair.status !== "ready")
    .map((pair) => `${pair.pair.join("->")}:${pair.status}`);
  throw new Error(`Release host matrix is not ready: ${blockers.join(", ")}`);
}

const deterministic = runJson("deterministic-cli.cjs", []);
let remainingBudget = initialBudget;
const cohortPaths = [];
const cohortSpecs = [
  ["codex", "share-markdown"],
  ["claude", "share-markdown"],
  ["codex", "read-shared-artifact"],
  ["claude", "read-shared-artifact"],
  ["codex", "autonomous-handoff", "claude"],
  ["claude", "autonomous-handoff", "codex"],
];
for (const [agentA, scenario, agentB] of cohortSpecs) {
  const result = runJson("cohort-cli.cjs", [
    "--agent-a", agentA,
    ...(agentB === undefined ? [] : ["--agent-b", agentB]),
    "--scenario", scenario,
    "--profile", "release",
    "--trials", String(trials),
    "--maximum-budget-usd", String(remainingBudget),
  ]);
  if (typeof result.jsonPath !== "string" || typeof result.remaining_budget_usd !== "number") {
    throw new Error("Release cohort did not return its evidence path and remaining budget");
  }
  cohortPaths.push(result.jsonPath);
  remainingBudget = result.remaining_budget_usd;
}

const evidenceRoot = resolve(repositoryRoot, "eval-results", "release-evidence", randomUUID());
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await copyFile(deterministic.report, resolve(evidenceRoot, "deterministic-report.json"));
const cohortReferences = [];
for (const [index, path] of cohortPaths.entries()) {
  const name = `cohort-${index + 1}.json`;
  await copyFile(path, resolve(evidenceRoot, name));
  cohortReferences.push(name);
}
const manifestPath = resolve(evidenceRoot, "release-evidence.json");
await writeFile(manifestPath, `${JSON.stringify({
  version: 1,
  candidate_sha256: deterministic.outcome === "pass"
    ? JSON.parse(await readFile(deterministic.report, "utf8")).candidate.sha256
    : "",
  created_at: new Date().toISOString(),
  reports: ["deterministic-report.json"],
  cohorts: cohortReferences,
}, null, 2)}\n`, { mode: 0o600 });

const release = spawnSync(process.execPath, [
  resolve(evalRunnerRoot, "release-cli.cjs"),
  "--manifest", manifestPath,
], {
  cwd: repositoryRoot,
  env: process.env,
  encoding: "utf8",
  stdio: "inherit",
});
if (release.error !== undefined) throw release.error;
if (release.status !== 0) process.exitCode = release.status ?? 1;
else process.stdout.write(`${JSON.stringify({ manifest: manifestPath, remaining_budget_usd: remainingBudget })}\n`);
