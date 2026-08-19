import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { cohortReportSchema, wilsonInterval } from "../src/aggregation";
import { evaluateReleasePolicy, releasePolicySchema } from "../src/release-policy";

const candidate = "a".repeat(64);
const calibrationRuns = Array.from({ length: 20 }, () => randomUUID());
const calibrationRun = calibrationRuns[0]!;
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
    calibration_run_ids: calibrationRuns,
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
    wilson_95: wilsonInterval(20, 20),
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
  it("rejects calibrated policy rules with fewer calibration runs than required trials", () => {
    const underCalibratedRule = {
      ...policy.cohorts[0]!,
      calibration_run_ids: calibrationRuns.slice(0, 19),
    };

    const parsed = releasePolicySchema.safeParse({ ...policy, cohorts: [underCalibratedRule] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["cohorts", 0, "calibration_run_ids"],
          message: "Calibrated cohorts require at least minimum_trials calibration runs",
        }),
      ]));
    }

    const decision = evaluateReleasePolicy({
      policy: { ...policy, cohorts: [underCalibratedRule] },
      candidateSha256: candidate,
      cohorts: [cohort(Array.from({ length: 20 }, () => randomUUID()))],
    });
    expect(decision.failures).toContain("cross-vendor has fewer than 20 calibration trials");
  });

  it("accepts a fresh qualifying cohort", () => {
    const decision = evaluateReleasePolicy({
      policy,
      candidateSha256: candidate,
      cohorts: [cohort(Array.from({ length: 20 }, () => randomUUID()))],
    });
    expect(decision).toEqual({ eligible: true, failures: [] });
  });

  it("rejects calibration reuse, candidate mismatch, and hard failures", () => {
    const runIds = [calibrationRun, ...Array.from({ length: 19 }, () => randomUUID())];
    const reused = cohort(runIds, {
      behavioral_trials: 19,
      successes: 19,
      observed_success_rate: 1,
      wilson_95: wilsonInterval(19, 19),
      outcomes: {
        pass: 19,
        behavior_failure: 0,
        safety_failure: 1,
        infrastructure_failure: 0,
        timeout: 0,
        incomplete: 0,
        skipped: 0,
        teardown_failure: 0,
      },
      hard_failures: [{ run_id: runIds[1], outcome: "safety_failure", code: "canary" }],
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

  it.each([
    {
      name: "insufficient behavioral trials",
      rule: {},
      report: {
        total_trials: 19,
        behavioral_trials: 19,
        successes: 19,
        observed_success_rate: 1,
        wilson_95: wilsonInterval(19, 19),
        outcomes: {
          pass: 19,
          behavior_failure: 0,
          safety_failure: 0,
          infrastructure_failure: 0,
          timeout: 0,
          incomplete: 0,
          skipped: 0,
          teardown_failure: 0,
        },
      },
      failure: "cross-vendor has fewer than 20 behavioral trials",
    },
    {
      name: "low observed success rate",
      rule: { minimum_wilson_lower_bound: 0 },
      report: {
        successes: 17,
        observed_success_rate: 0.85,
        wilson_95: wilsonInterval(17, 20),
        outcomes: {
          pass: 17,
          behavior_failure: 3,
          safety_failure: 0,
          infrastructure_failure: 0,
          timeout: 0,
          incomplete: 0,
          skipped: 0,
          teardown_failure: 0,
        },
      },
      failure: "cross-vendor is below its observed success threshold",
    },
    {
      name: "low Wilson lower bound",
      rule: {},
      report: {
        successes: 18,
        observed_success_rate: 0.9,
        wilson_95: wilsonInterval(18, 20),
        outcomes: {
          pass: 18,
          behavior_failure: 2,
          safety_failure: 0,
          infrastructure_failure: 0,
          timeout: 0,
          incomplete: 0,
          skipped: 0,
          teardown_failure: 0,
        },
      },
      failure: "cross-vendor is below its Wilson lower-bound threshold",
    },
  ])("rejects $name while the cohort is otherwise eligible", ({ rule, report, failure }) => {
    const trialCount = report.total_trials ?? 20;
    const qualifyingPolicy = {
      ...policy,
      cohorts: [{ ...policy.cohorts[0]!, ...rule }],
    };
    const decision = evaluateReleasePolicy({
      policy: qualifyingPolicy,
      candidateSha256: candidate,
      cohorts: [cohort(Array.from({ length: trialCount }, () => randomUUID()), report)],
    });

    expect(decision).toEqual({ eligible: false, failures: [failure] });
  });
});
