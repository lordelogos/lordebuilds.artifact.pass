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
  scenario_version: z.number().int().positive(),
  scenario_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  scorer_version: z.string().min(1),
  gate_class: z.enum(["deterministic", "installation", "behavioral", "safety"]),
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
}).strict().superRefine((report, context) => {
  const uniqueRunIds = new Set(report.trial_run_ids);
  if (uniqueRunIds.size !== report.trial_run_ids.length) {
    context.addIssue({ code: "custom", path: ["trial_run_ids"], message: "Trial run IDs must be unique" });
  }
  const totalOutcomes = Object.values(report.outcomes).reduce((sum, count) => sum + count, 0);
  const expectedBehavioral = report.gate_class === "behavioral"
    ? report.outcomes.pass + report.outcomes.behavior_failure
    : 0;
  const expectedSuccesses = report.gate_class === "behavioral" ? report.outcomes.pass : 0;
  const expectedWilson = wilsonInterval(expectedSuccesses, expectedBehavioral);
  const expectedRate = expectedBehavioral === 0 ? 0 : expectedSuccesses / expectedBehavioral;
  const expectedInfrastructure = report.outcomes.infrastructure_failure + report.outcomes.timeout + report.outcomes.incomplete;
  const expectedEligible = report.gate_class === "behavioral" &&
    report.hard_failures.length === 0 &&
    expectedBehavioral === report.total_trials;
  const checks: readonly [boolean, (string | number)[], string][] = [
    [report.total_trials === report.trial_run_ids.length, ["total_trials"], "Trial count must match run IDs"],
    [totalOutcomes === report.total_trials, ["outcomes"], "Outcome counts must sum to total trials"],
    [report.behavioral_trials === expectedBehavioral, ["behavioral_trials"], "Behavioral count must match outcomes"],
    [report.successes === expectedSuccesses, ["successes"], "Successes must match behavioral passing outcomes"],
    [Math.abs(report.observed_success_rate - expectedRate) < 1e-12, ["observed_success_rate"], "Success rate must be derived from outcomes"],
    [Math.abs(report.wilson_95.lower - expectedWilson.lower) < 1e-12, ["wilson_95", "lower"], "Wilson lower bound must be derived from outcomes"],
    [Math.abs(report.wilson_95.upper - expectedWilson.upper) < 1e-12, ["wilson_95", "upper"], "Wilson upper bound must be derived from outcomes"],
    [report.infrastructure_runs.length === expectedInfrastructure, ["infrastructure_runs"], "Infrastructure run count must match outcomes"],
    [report.skipped_runs.length === report.outcomes.skipped, ["skipped_runs"], "Skipped run count must match outcomes"],
    [report.eligible_for_threshold === expectedEligible, ["eligible_for_threshold"], "Eligibility must match hard and behavioral outcomes"],
  ];
  for (const [matches, path, message] of checks) {
    if (!matches) context.addIssue({ code: "custom", path, message });
  }
  for (const runId of [...report.infrastructure_runs, ...report.skipped_runs, ...report.hard_failures.map((failure) => failure.run_id)]) {
    if (!uniqueRunIds.has(runId)) {
      context.addIssue({ code: "custom", path: ["trial_run_ids"], message: "Classified runs must belong to the cohort" });
      break;
    }
  }
});

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
  const runIds = new Set<string>();
  for (const report of reports) {
    if (runIds.has(report.run_id)) throw new Error("Cohort trial run IDs must be unique");
    runIds.add(report.run_id);
    if (
      report.candidate.sha256 !== first.candidate.sha256 ||
      report.scenario.id !== first.scenario.id ||
      report.scenario.version !== first.scenario.version ||
      report.scenario.sha256 !== first.scenario.sha256 ||
      report.scorer_version !== first.scorer_version ||
      report.result.gate_class !== first.result.gate_class ||
      report.host.agent_a !== first.host.agent_a ||
      report.host.agent_b !== first.host.agent_b
    ) throw new Error("Cohort reports must share candidate, scenario, scorer, and ordered host pair");
  }
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    reports.filter((report) => report.result.outcome === outcome).length,
  ])) as Record<(typeof OUTCOMES)[number], number>;
  const behavioral = reports.filter((report) => report.result.gate_class === "behavioral" &&
    (report.result.outcome === "pass" || report.result.outcome === "behavior_failure"));
  const successes = behavioral.filter((report) => report.result.outcome === "pass").length;
  const hardFailures = reports.flatMap((report) => {
    const hard = report.result.outcome === "safety_failure" ||
      report.result.outcome === "teardown_failure" ||
      (report.result.gate_class === "safety" && report.result.outcome === "behavior_failure") ||
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
    scenario_version: first.scenario.version,
    scenario_sha256: first.scenario.sha256,
    scorer_version: first.scorer_version,
    gate_class: first.result.gate_class,
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
    eligible_for_threshold: first.result.gate_class === "behavioral" &&
      hardFailures.length === 0 &&
      behavioral.length === reports.length &&
      reports.every((report) => report.result.teardown !== "failed"),
  });
};
