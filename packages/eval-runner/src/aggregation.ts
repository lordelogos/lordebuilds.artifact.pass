import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { EvalReport } from "./contracts";

export const COHORT_REPORT_VERSION = 1 as const;

export const wilsonInterval = (
  successes: number,
  trials: number,
  zScore = 1.959963984540054,
): { readonly lower: number; readonly upper: number } => {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 0 || successes > trials) {
    throw new Error("Wilson interval requires integer successes within the trial count");
  }
  if (trials === 0) return { lower: 0, upper: 1 };
  const probability = successes / trials;
  const zSquared = zScore ** 2;
  const denominator = 1 + zSquared / trials;
  const centre = probability + zSquared / (2 * trials);
  const margin = zScore * Math.sqrt((probability * (1 - probability) + zSquared / (4 * trials)) / trials);
  return {
    lower: successes === 0 ? 0 : Math.max(0, (centre - margin) / denominator),
    upper: successes === trials ? 1 : Math.min(1, (centre + margin) / denominator),
  };
};

const outcomeCountSchema = z.object({
  pass: z.number().int().nonnegative(),
  behavior_failure: z.number().int().nonnegative(),
  safety_failure: z.number().int().nonnegative(),
  infrastructure_failure: z.number().int().nonnegative(),
  timeout: z.number().int().nonnegative(),
  incomplete: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  teardown_failure: z.number().int().nonnegative(),
}).strict();

export const cohortReportSchema = z.object({
  version: z.literal(COHORT_REPORT_VERSION),
  cohort_run_id: z.uuid(),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  scenario_id: z.string().min(1),
  scorer_version: z.string().min(1),
  host_pair: z.tuple([z.enum(["generic", "codex", "claude"]), z.enum(["generic", "codex", "claude"])]),
  trial_run_ids: z.array(z.uuid()).min(1),
  total_trials: z.number().int().positive(),
  behavioral_trials: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  observed_success_rate: z.number().min(0).max(1),
  wilson_95: z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1) }).strict(),
  outcomes: outcomeCountSchema,
  hard_failures: z.array(z.object({ run_id: z.uuid(), outcome: z.string(), code: z.string() }).strict()),
  infrastructure_runs: z.array(z.uuid()),
  skipped_runs: z.array(z.uuid()),
  eligible_for_threshold: z.boolean(),
}).strict();

export type CohortReport = z.infer<typeof cohortReportSchema>;

const OUTCOMES = [
  "pass",
  "behavior_failure",
  "safety_failure",
  "infrastructure_failure",
  "timeout",
  "incomplete",
  "skipped",
  "teardown_failure",
] as const;

export const aggregateCohort = (reports: readonly EvalReport[]): CohortReport => {
  if (reports.length === 0) throw new Error("Cannot aggregate an empty cohort");
  const first = reports[0]!;
  for (const report of reports) {
    if (
      report.candidate.sha256 !== first.candidate.sha256 ||
      report.scenario.id !== first.scenario.id ||
      report.scorer_version !== first.scorer_version ||
      report.host.agent_a !== first.host.agent_a ||
      report.host.agent_b !== first.host.agent_b
    ) throw new Error("Cohort reports must share candidate, scenario, scorer, and ordered host pair");
  }
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    reports.filter((report) => report.result.outcome === outcome).length,
  ])) as Record<(typeof OUTCOMES)[number], number>;
  const behavioral = reports.filter((report) =>
    report.result.outcome === "pass" || report.result.outcome === "behavior_failure");
  const successes = behavioral.filter((report) => report.result.outcome === "pass").length;
  const hardFailures = reports.flatMap((report) => {
    const hard = report.result.outcome === "safety_failure" ||
      report.result.outcome === "teardown_failure" ||
      ((report.result.gate_class === "deterministic" || report.result.gate_class === "installation") &&
        report.result.outcome !== "pass");
    if (!hard) return [];
    return [{
      run_id: report.run_id,
      outcome: report.result.outcome,
      code: report.result.failures[0]?.code ?? report.result.outcome,
    }];
  });
  return cohortReportSchema.parse({
    version: COHORT_REPORT_VERSION,
    cohort_run_id: randomUUID(),
    candidate_sha256: first.candidate.sha256,
    scenario_id: first.scenario.id,
    scorer_version: first.scorer_version,
    host_pair: [first.host.agent_a, first.host.agent_b ?? first.host.agent_a],
    trial_run_ids: reports.map((report) => report.run_id),
    total_trials: reports.length,
    behavioral_trials: behavioral.length,
    successes,
    observed_success_rate: behavioral.length === 0 ? 0 : successes / behavioral.length,
    wilson_95: wilsonInterval(successes, behavioral.length),
    outcomes,
    hard_failures: hardFailures,
    infrastructure_runs: reports
      .filter((report) => ["infrastructure_failure", "timeout", "incomplete"].includes(report.result.outcome))
      .map((report) => report.run_id),
    skipped_runs: reports.filter((report) => report.result.outcome === "skipped").map((report) => report.run_id),
    eligible_for_threshold: hardFailures.length === 0 &&
      behavioral.length === reports.length &&
      reports.every((report) => report.result.teardown !== "failed"),
  });
};
