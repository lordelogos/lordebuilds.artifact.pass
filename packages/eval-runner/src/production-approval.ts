import { z } from "zod";

const hostSchema = z.enum(["generic", "codex", "claude"]);

export const productionApprovalSchema = z.object({
  version: z.literal(1),
  approval_id: z.uuid(),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  scenario_ids: z.array(z.string().min(1)).min(1),
  ordered_host_pairs: z.array(z.tuple([hostSchema, hostSchema])).min(1),
  budgets: z.object({
    maximum_cost_usd: z.number().positive(),
    maximum_duration_ms: z.number().int().positive(),
    maximum_trials: z.number().int().positive(),
  }).strict(),
  resource_identities: z.array(z.string().min(1)).min(1),
  issued_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  approver: z.string().min(1),
  signature: z.string().min(32),
}).strict().superRefine((approval, context) => {
  const lifetime = Date.parse(approval.expires_at) - Date.parse(approval.issued_at);
  if (lifetime <= 0 || lifetime > 60 * 60 * 1000) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "Production approval lifetime must be at most one hour" });
  }
});

export type ProductionApproval = z.infer<typeof productionApprovalSchema>;

export const verifyProductionApproval = async (options: {
  readonly approval: ProductionApproval;
  readonly expectedCandidateSha256: string;
  readonly now: number;
  readonly consumedApprovalIds: ReadonlySet<string>;
  readonly expected: {
    readonly scenarioIds: readonly string[];
    readonly orderedHostPairs: readonly (readonly ["generic" | "codex" | "claude", "generic" | "codex" | "claude"])[];
    readonly budgets: ProductionApproval["budgets"];
    readonly resourceIdentities: readonly string[];
  };
  readonly verifySignature: (approval: ProductionApproval) => Promise<boolean>;
}): Promise<void> => {
  const approval = productionApprovalSchema.parse(options.approval);
  if (approval.candidate_sha256 !== options.expectedCandidateSha256) {
    throw new Error("Production approval is bound to a different candidate");
  }
  if (Date.parse(approval.issued_at) > options.now || Date.parse(approval.expires_at) <= options.now) {
    throw new Error("Production approval is not currently valid");
  }
  if (options.consumedApprovalIds.has(approval.approval_id)) {
    throw new Error("Production approval has already been consumed");
  }
  if (
    JSON.stringify(approval.scenario_ids) !== JSON.stringify(options.expected.scenarioIds) ||
    JSON.stringify(approval.ordered_host_pairs) !== JSON.stringify(options.expected.orderedHostPairs) ||
    JSON.stringify(approval.budgets) !== JSON.stringify(options.expected.budgets) ||
    JSON.stringify(approval.resource_identities) !== JSON.stringify(options.expected.resourceIdentities)
  ) {
    throw new Error("Production approval scope does not match the requested run");
  }
  if (!await options.verifySignature(approval)) {
    throw new Error("Production approval signature is invalid");
  }
};
