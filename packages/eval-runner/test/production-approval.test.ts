import { describe, expect, it, vi } from "vitest";

import { productionApprovalSchema, verifyProductionApproval } from "../src/production-approval";

const approval = productionApprovalSchema.parse({
  version: 1,
  approval_id: "8e885d98-7491-4ef8-84fe-1b8fea4c7235",
  candidate_sha256: "a".repeat(64),
  scenario_ids: ["autonomous-handoff"],
  ordered_host_pairs: [["codex", "claude"], ["claude", "codex"]],
  budgets: { maximum_cost_usd: 20, maximum_duration_ms: 3_600_000, maximum_trials: 40 },
  resource_identities: ["artifactpass-production-evals"],
  issued_at: "2026-08-19T03:00:00.000Z",
  expires_at: "2026-08-19T04:00:00.000Z",
  approver: "release-owner",
  signature: "signed-production-approval-material",
});

const expected = {
  scenarioIds: approval.scenario_ids,
  orderedHostPairs: approval.ordered_host_pairs,
  budgets: approval.budgets,
  resourceIdentities: approval.resource_identities,
};

describe("production approval", () => {
  it("accepts an authenticated, current, unused candidate-bound approval", async () => {
    const verifySignature = vi.fn().mockResolvedValue(true);
    await expect(verifyProductionApproval({
      approval,
      expectedCandidateSha256: "a".repeat(64),
      now: Date.parse("2026-08-19T03:30:00.000Z"),
      consumedApprovalIds: new Set(),
      expected,
      verifySignature,
    })).resolves.toBeUndefined();
    expect(verifySignature).toHaveBeenCalledOnce();
  });

  it.each([
    ["candidate", { expectedCandidateSha256: "b".repeat(64), now: Date.parse("2026-08-19T03:30:00.000Z"), consumed: new Set<string>(), signature: true }],
    ["expired", { expectedCandidateSha256: "a".repeat(64), now: Date.parse("2026-08-19T04:00:00.000Z"), consumed: new Set<string>(), signature: true }],
    ["consumed", { expectedCandidateSha256: "a".repeat(64), now: Date.parse("2026-08-19T03:30:00.000Z"), consumed: new Set([approval.approval_id]), signature: true }],
    ["signature", { expectedCandidateSha256: "a".repeat(64), now: Date.parse("2026-08-19T03:30:00.000Z"), consumed: new Set<string>(), signature: false }],
  ])("rejects an invalid %s boundary", async (_name, options) => {
    await expect(verifyProductionApproval({
      approval,
      expectedCandidateSha256: options.expectedCandidateSha256,
      now: options.now,
      consumedApprovalIds: options.consumed,
      expected,
      verifySignature: async () => options.signature,
    })).rejects.toThrow();
  });

  it("rejects a signed approval whose scenario scope differs", async () => {
    await expect(verifyProductionApproval({
      approval,
      expectedCandidateSha256: "a".repeat(64),
      now: Date.parse("2026-08-19T03:30:00.000Z"),
      consumedApprovalIds: new Set(),
      expected: { ...expected, scenarioIds: ["different-scenario"] },
      verifySignature: async () => true,
    })).rejects.toThrow(/scope/u);
  });
});
