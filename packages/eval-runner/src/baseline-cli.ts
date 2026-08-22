import { join, resolve } from "node:path";

import { aggregateCohort } from "./aggregation";
import { runDeterministicProfile } from "./runner";
import { writeCohortReport } from "./reporting";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const main = async (): Promise<void> => {
  const hosts = (argument("--hosts") ?? "generic").split(",").filter(Boolean);
  const trials = Number(argument("--trials") ?? "10");
  if (hosts.some((host) => host !== "generic")) {
    throw new Error(
      "Model-host baseline is blocked until isolated provider authentication, distinct principals, and enforced host containment are proven. Run pnpm eval:matrix for details.",
    );
  }
  if (!Number.isInteger(trials) || trials < 10 || trials > 100) {
    throw new Error("Baseline trials must be an integer from 10 through 100");
  }
  const repositoryRoot = resolve(process.cwd());
  const reports = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const result = await runDeterministicProfile({
      repositoryRoot,
      cohort: { profile: "baseline", trialIndex: trial + 1, trialCount: trials },
    });
    reports.push(result.report);
    process.stderr.write(`ArtifactPass baseline trial ${trial + 1}/${trials}: ${result.report.result.outcome}\n`);
  }
  const cohort = aggregateCohort(reports);
  const paths = await writeCohortReport(join(repositoryRoot, "eval-results", "baselines"), cohort);
  process.stdout.write(`${JSON.stringify({ cohort, ...paths }, null, 2)}\n`);
  if (cohort.hard_failures.length > 0 || cohort.outcomes.pass !== cohort.total_trials) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Baseline failed"}\n`);
  process.exitCode = 1;
});
