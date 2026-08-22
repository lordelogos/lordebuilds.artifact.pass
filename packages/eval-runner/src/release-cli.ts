import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

import { aggregateCohort, cohortReportSchema } from "./aggregation";
import { candidateDigest } from "./candidate-digest";
import { evalReportSchema, evalScenarioSchema } from "./contracts";
import {
  buildMatrixPreflight,
  hostMatrixConfigurationSchema,
  matrixReleaseEligible,
} from "./host-matrix";
import { runtimeVersionForHost } from "./model-host";
import { evaluateReleasePolicy, releasePolicySchema } from "./release-policy";
import { loadReleaseEvidenceManifest } from "./release-evidence";

const values = (name: string): readonly string[] => process.argv.flatMap((value, index) =>
  value === name && process.argv[index + 1] !== undefined ? [process.argv[index + 1]!] : []);

const main = async (): Promise<void> => {
  const repositoryRoot = resolve(process.cwd());
  const candidateSha256 = await candidateDigest(repositoryRoot);
  const policy = releasePolicySchema.parse(JSON.parse(await readFile(
    join(repositoryRoot, "evals/release-policy.json"),
    "utf8",
  )));
  const manifestPath = values("--manifest")[0];
  const manifestEvidence = manifestPath === undefined
    ? undefined
    : await loadReleaseEvidenceManifest(resolve(manifestPath));
  if (manifestEvidence !== undefined && manifestEvidence.manifest.candidate_sha256 !== candidateSha256) {
    throw new Error("Release evidence manifest is bound to a different candidate");
  }
  if (manifestEvidence !== undefined) {
    const sourceCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    if (manifestEvidence.manifest.source_commit_sha !== sourceCommitSha) {
      throw new Error("Release evidence manifest is bound to a different source commit");
    }
  }
  const cohortPaths = [...values("--cohort"), ...(manifestEvidence?.cohorts ?? [])];
  const reportPaths = [...values("--report"), ...(manifestEvidence?.reports ?? [])];
  const suppliedCohorts = await Promise.all(cohortPaths.map(async (path) =>
    cohortReportSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")))));
  const hardGateReports = await Promise.all(reportPaths.map(async (path) =>
    evalReportSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")))));
  const cohorts = [...suppliedCohorts, ...hardGateReports.map((report) => aggregateCohort([report]))];
  const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
    join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json"),
    "utf8",
  )));
  const matrixConfiguration = hostMatrixConfigurationSchema.parse(JSON.parse(await readFile(
    join(repositoryRoot, "evals/scenarios/host-matrix.json"),
    "utf8",
  )));
  const [codexVersion, claudeVersion] = await Promise.all([
    runtimeVersionForHost("codex"),
    runtimeVersionForHost("claude"),
  ]);
  const matrix = buildMatrixPreflight({
    configuration: matrixConfiguration,
    scenario,
    portableBundleSha256: candidateSha256,
    runtimeVersions: {
      codex: codexVersion ?? "unavailable",
      claude: claudeVersion ?? "unavailable",
    },
  });
  const policyDecision = evaluateReleasePolicy({ policy, candidateSha256, cohorts });
  const decision = {
    version: 1,
    eligible: policyDecision.eligible && matrixReleaseEligible(matrix, matrixConfiguration),
    policy_failures: policyDecision.failures,
    matrix_blockers: matrix
      .filter((dispatch) => dispatch.blocking && dispatch.status !== "ready")
      .map((dispatch) => ({ pair: dispatch.pair, status: dispatch.status, reasons: dispatch.reasons })),
  };
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  if (!decision.eligible && !process.argv.includes("--dry-run")) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Release evaluation failed"}\n`);
  process.exitCode = 1;
});
