import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { aggregateCohort, cohortReportSchema, wilsonInterval } from "../src/aggregation";
import type { EvalReport } from "../src/contracts";

const candidate = "a".repeat(64);
const report = (outcome: EvalReport["result"]["outcome"], runId = randomUUID()): EvalReport => ({
  version: 1,
  run_id: runId,
  candidate: { sha256: candidate },
  receipt_version: 1,
  scenario: { id: "generic-fidelity", version: 1 },
  scorer_version: "1.0.0",
  host: { agent_a: "generic", agent_b: "generic", runtime: "node-test" },
  cohort: { profile: "baseline", trial_index: 1, trial_count: 10 },
  result: {
    version: 1,
    run_id: runId,
    scenario_id: "generic-fidelity",
    candidate_sha256: candidate,
    started_at: "2026-08-19T03:00:00.000Z",
    completed_at: "2026-08-19T03:00:01.000Z",
    trial_outcome: outcome === "teardown_failure" ? "pass" : outcome,
    outcome,
    gate_class: "behavioral",
    host_pair: { agent_a: "generic", agent_b: "generic" },
    ...(outcome === "infrastructure_failure" ? { infrastructure_code: "fixture" } : {}),
    teardown: outcome === "teardown_failure" ? "failed" : "passed",
    observed_actions: [],
    failures: outcome === "pass" ? [] : [{ code: outcome, message: outcome }],
  },
  latency_ms: 1000,
  usage: {},
});

describe("cohort aggregation", () => {
  it("calculates a known 10/10 Wilson interval", () => {
    const interval = wilsonInterval(10, 10);
    expect(interval.lower).toBeCloseTo(0.722467, 5);
    expect(interval.upper).toBe(1);
  });

  it("keeps infrastructure, skipped, safety, and teardown outcomes out of behavioral averages", () => {
    const cohort = aggregateCohort([
      report("pass"),
      report("behavior_failure"),
      report("infrastructure_failure"),
      report("skipped"),
      report("safety_failure"),
      report("teardown_failure"),
    ]);
    expect(cohort).toMatchObject({
      total_trials: 6,
      behavioral_trials: 2,
      successes: 1,
      observed_success_rate: 0.5,
      eligible_for_threshold: false,
    });
    expect(cohort.hard_failures).toHaveLength(2);
    expect(cohort.infrastructure_runs).toHaveLength(1);
    expect(cohort.skipped_runs).toHaveLength(1);
  });

  it("rejects mixed candidates or host pairs", () => {
    const other = report("pass");
    expect(() => aggregateCohort([
      report("pass"),
      { ...other, candidate: { sha256: "b".repeat(64) } },
    ])).toThrow(/must share/u);
  });

  it("rejects duplicate trial IDs", () => {
    const duplicate = randomUUID();
    expect(() => aggregateCohort([report("pass", duplicate), report("pass", duplicate)]))
      .toThrow(/unique/u);
  });

  it("rejects internally inconsistent serialized cohorts", () => {
    const cohort = aggregateCohort([report("pass")]);
    expect(cohortReportSchema.safeParse({ ...cohort, total_trials: 20 }).success).toBe(false);
    expect(cohortReportSchema.safeParse({
      ...cohort,
      trial_run_ids: [cohort.trial_run_ids[0], cohort.trial_run_ids[0]],
      total_trials: 2,
      outcomes: { ...cohort.outcomes, pass: 2 },
      behavioral_trials: 2,
      successes: 2,
      observed_success_rate: 1,
      wilson_95: wilsonInterval(2, 2),
    }).success).toBe(false);
  });
});
