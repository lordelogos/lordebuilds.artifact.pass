import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { cohortReportSchema } from "./aggregation";
import { candidateDigest } from "./candidate-digest";
import { evalScenarioSchema } from "./contracts";
import { buildMatrixPreflight, matrixReleaseEligible } from "./host-matrix";
import { evaluateReleasePolicy, releasePolicySchema } from "./release-policy";

const values = (name: string): readonly string[] => process.argv.flatMap((value, index) =>
  value === name && process.argv[index + 1] !== undefined ? [process.argv[index + 1]!] : []);

const main = async (): Promise<void> => {
  const repositoryRoot = resolve(process.cwd());
  const candidateSha256 = await candidateDigest(repositoryRoot);
  const policy = releasePolicySchema.parse(JSON.parse(await readFile(
    join(repositoryRoot, "evals/release-policy.json"),
    "utf8",
  )));
  const cohorts = await Promise.all(values("--cohort").map(async (path) =>
    cohortReportSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")))));
  const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
    join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json"),
    "utf8",
  )));
  const matrix = buildMatrixPreflight({ scenario, portableBundleSha256: candidateSha256 });
  const policyDecision = evaluateReleasePolicy({ policy, candidateSha256, cohorts });
  const decision = {
    version: 1,
    eligible: policyDecision.eligible && matrixReleaseEligible(matrix),
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
