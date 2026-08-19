import { join, resolve } from "node:path";

import { aggregateCohort } from "./aggregation";
import { type HostId } from "./hosts/host";
import { runModelHandoffTrial } from "./model-handoff";
import { writeCohortReport } from "./reporting";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const host = (name: string): HostId => {
  const value = argument(name);
  if (value !== "codex" && value !== "claude") throw new Error(`${name} must be codex or claude`);
  return value;
};

const main = async (): Promise<void> => {
  const agentA = host("--agent-a");
  const agentB = host("--agent-b");
  const trials = Number(argument("--trials") ?? "1");
  const profile = argument("--profile") ?? "smoke";
  if (profile !== "smoke" && profile !== "baseline" && profile !== "release") {
    throw new Error("--profile must be smoke, baseline, or release");
  }
  const minimum = profile === "baseline" ? 10 : profile === "release" ? 20 : 1;
  if (!Number.isInteger(trials) || trials < minimum || trials > 100) {
    throw new Error(`${profile} cohorts require ${minimum} through 100 trials`);
  }
  const repositoryRoot = resolve(process.cwd());
  const reports = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    const result = await runModelHandoffTrial({
      agentA,
      agentB,
      repositoryRoot,
      profile,
      trialIndex: trial,
      trialCount: trials,
    });
    if (result.status !== "completed" || result.report === undefined) throw new Error(result.reason ?? "Model handoff blocked");
    reports.push(result.report);
    process.stderr.write(`ArtifactPass ${agentA} -> ${agentB} trial ${trial}/${trials}: ${result.report.result.outcome}\n`);
  }
  const cohort = aggregateCohort(reports);
  const paths = await writeCohortReport(join(repositoryRoot, "eval-results", `${profile}s`), cohort);
  process.stdout.write(`${JSON.stringify({
    cohort,
    ...paths,
    release_qualification: "Run pnpm eval:matrix; behavioral success does not override containment, identity, or skill-observability blockers.",
  }, null, 2)}\n`);
  if (!cohort.eligible_for_threshold) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Model cohort failed"}\n`);
  process.exitCode = 1;
});
