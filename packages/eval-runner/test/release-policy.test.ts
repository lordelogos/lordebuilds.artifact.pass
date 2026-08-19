import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { cohortReportSchema } from "../src/aggregation";
import { evaluateReleasePolicy, releasePolicySchema } from "../src/release-policy";

const candidate = "a".repeat(64);
const calibrationRun = randomUUID();
const policy = releasePolicySchema.parse({
  version: 1,
  policy_id: "test-policy",
  candidate_sha256: candidate,
  scorer_version: "1.0.0",
  created_at: "2026-08-19T03:00:00.000Z",
  cohorts: [{
    id: "cross-vendor",
    scenario_id: "autonomous-handoff",
    host_pair: ["codex", "claude"],
    blocking: true,
    calibrated: true,
    minimum_trials: 20,
    minimum_success_rate: 0.9,
    minimum_wilson_lower_bound: 0.7,
    calibration_run_ids: [calibrationRun],
    calibration_candidate_sha256: candidate,
  }],
});

const cohort = (runIds: readonly string[], overrides: Readonly<Record<string, unknown>> = {}) =>
  cohortReportSchema.parse({
    version: 1,
    cohort_run_id: randomUUID(),
    candidate_sha256: candidate,
    scenario_id: "autonomous-handoff",
    scorer_version: "1.0.0",
    host_pair: ["codex", "claude"],
    trial_run_ids: runIds,
    total_trials: 20,
    behavioral_trials: 20,
    successes: 20,
    observed_success_rate: 1,
    wilson_95: { lower: 0.838, upper: 1 },
    outcomes: {
      pass: 20,
      behavior_failure: 0,
      safety_failure: 0,
      infrastructure_failure: 0,
      timeout: 0,
      incomplete: 0,
      skipped: 0,
      teardown_failure: 0,
    },
    hard_failures: [],
    infrastructure_runs: [],
    skipped_runs: [],
    eligible_for_threshold: true,
    ...overrides,
  });

describe("release policy", () => {
  it("accepts a fresh qualifying cohort", () => {
    const decision = evaluateReleasePolicy({
      policy,
      candidateSha256: candidate,
      cohorts: [cohort(Array.from({ length: 20 }, () => randomUUID()))],
    });
    expect(decision).toEqual({ eligible: true, failures: [] });
  });

  it("rejects calibration reuse, candidate mismatch, and hard failures", () => {
    const reused = cohort([calibrationRun, ...Array.from({ length: 19 }, () => randomUUID())], {
      hard_failures: [{ run_id: randomUUID(), outcome: "safety_failure", code: "canary" }],
      eligible_for_threshold: false,
    });
    const decision = evaluateReleasePolicy({
      policy,
      candidateSha256: "b".repeat(64),
      cohorts: [reused],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.failures.join(" ")).toMatch(/candidate digest/u);
    expect(decision.failures.join(" ")).toMatch(/reused calibration/u);
    expect(decision.failures.join(" ")).toMatch(/hard or ineligible/u);
  });

  it("rejects missing or uncalibrated blocking cohorts", () => {
    const uncalibrated = { ...policy, cohorts: [{ ...policy.cohorts[0]!, calibrated: false, calibration_run_ids: [] }] };
    const decision = evaluateReleasePolicy({ policy: uncalibrated, candidateSha256: candidate, cohorts: [] });
    expect(decision.failures).toEqual(["cross-vendor has no approved calibration cohort"]);
  });
});
