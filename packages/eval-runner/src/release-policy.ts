import { z } from "zod";

import type { CohortReport } from "./aggregation";

const hostSchema = z.enum(["generic", "codex", "claude"]);

export const releasePolicySchema = z.object({
  version: z.literal(1),
  policy_id: z.string().min(1),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  scorer_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  created_at: z.iso.datetime({ offset: true }),
  cohorts: z.array(z.object({
    id: z.string().min(1),
    scenario_id: z.string().min(1),
    host_pair: z.tuple([hostSchema, hostSchema]),
    blocking: z.boolean(),
    calibrated: z.boolean(),
    minimum_trials: z.number().int().positive(),
    minimum_success_rate: z.number().min(0).max(1),
    minimum_wilson_lower_bound: z.number().min(0).max(1),
    calibration_run_ids: z.array(z.uuid()),
    calibration_candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).strict()).min(1),
}).strict().superRefine((policy, context) => {
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const [index, cohort] of policy.cohorts.entries()) {
    if (ids.has(cohort.id)) {
      context.addIssue({ code: "custom", path: ["cohorts", index, "id"], message: "Cohort IDs must be unique" });
    }
    ids.add(cohort.id);
    const pair = `${cohort.scenario_id}:${cohort.host_pair.join("->")}`;
    if (pairs.has(pair)) {
      context.addIssue({ code: "custom", path: ["cohorts", index, "host_pair"], message: "Scenario host-pair rules must be unique" });
    }
    pairs.add(pair);
    if (cohort.calibrated && (
      cohort.calibration_run_ids.length === 0 ||
      cohort.calibration_candidate_sha256 === undefined
    )) {
      context.addIssue({ code: "custom", path: ["cohorts", index], message: "Calibrated cohorts require candidate-bound run evidence" });
    }
  }
});

export type ReleasePolicy = z.infer<typeof releasePolicySchema>;

export interface ReleasePolicyDecision {
  readonly eligible: boolean;
  readonly failures: readonly string[];
}

export const evaluateReleasePolicy = (options: {
  readonly policy: ReleasePolicy;
  readonly candidateSha256: string;
  readonly cohorts: readonly CohortReport[];
}): ReleasePolicyDecision => {
  const failures: string[] = [];
  if (options.policy.candidate_sha256 !== options.candidateSha256) {
    failures.push("Release policy candidate digest does not match the evaluated candidate");
  }
  for (const rule of options.policy.cohorts) {
    if (!rule.blocking) continue;
    if (!rule.calibrated || rule.calibration_run_ids.length === 0) {
      failures.push(`${rule.id} has no approved calibration cohort`);
      continue;
    }
    if (rule.calibration_candidate_sha256 !== options.policy.candidate_sha256) {
      failures.push(`${rule.id} calibration evidence is bound to a different candidate`);
    }
    const cohort = options.cohorts.find((candidate) =>
      candidate.scenario_id === rule.scenario_id &&
      candidate.host_pair[0] === rule.host_pair[0] &&
      candidate.host_pair[1] === rule.host_pair[1]);
    if (cohort === undefined) {
      failures.push(`${rule.id} has no fresh evaluation cohort`);
      continue;
    }
    if (cohort.candidate_sha256 !== options.candidateSha256) {
      failures.push(`${rule.id} evaluated a different candidate digest`);
    }
    if (cohort.scorer_version !== options.policy.scorer_version) {
      failures.push(`${rule.id} used a different scorer version`);
    }
    if (cohort.trial_run_ids.some((runId) => rule.calibration_run_ids.includes(runId))) {
      failures.push(`${rule.id} reused calibration trials as release evidence`);
    }
    if (!cohort.eligible_for_threshold || cohort.hard_failures.length > 0) {
      failures.push(`${rule.id} contains a hard or ineligible outcome`);
    }
    if (cohort.behavioral_trials < rule.minimum_trials) {
      failures.push(`${rule.id} has fewer than ${rule.minimum_trials} behavioral trials`);
    }
    if (cohort.observed_success_rate < rule.minimum_success_rate) {
      failures.push(`${rule.id} is below its observed success threshold`);
    }
    if (cohort.wilson_95.lower < rule.minimum_wilson_lower_bound) {
      failures.push(`${rule.id} is below its Wilson lower-bound threshold`);
    }
  }
  return { eligible: failures.length === 0, failures };
};
