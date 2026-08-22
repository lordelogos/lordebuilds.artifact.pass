import { z } from "zod";

export const EVAL_CONTRACT_VERSION = 1 as const;
export const NORMALIZED_HOST_EVENT_VERSION = 1 as const;
export const EVAL_RESULT_VERSION = 1 as const;
export const EVAL_REPORT_VERSION = 1 as const;

const kebabIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeFixturePathSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^evals\/fixtures\/(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/u)
  .superRefine((path, context) => {
    if (
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/u.test(path) ||
      path.split(/[\\/]/u).includes("..") ||
      !path.startsWith("evals/fixtures/")
    ) {
      context.addIssue({ code: "custom", message: "Fixture paths must remain under evals/fixtures" });
    }
  });

export const actionKindSchema = z.enum([
  "skill",
  "mcp_tool",
  "filesystem",
  "network",
  "process",
  "user_intervention",
  "artifact",
]);

export const actionReferenceSchema = z.object({
  kind: actionKindSchema,
  name: z.string().min(1).max(128),
}).strict();

const fixtureSchema = z.object({
  id: kebabIdSchema,
  path: relativeFixturePathSchema,
  mime_type: z.enum(["text/markdown", "text/html", "application/pdf"]),
  sha256: sha256Schema.optional(),
}).strict();

const budgetsSchema = z.object({
  timeout_ms: z.number().int().positive().max(30 * 60 * 1000),
  max_steps: z.number().int().positive().max(200),
  max_tool_calls: z.number().int().nonnegative().max(100),
  max_artifact_bytes: z.number().int().positive().max(25 * 1024 * 1024),
  max_trials: z.number().int().positive().max(100),
  estimated_cost_usd: z.number().nonnegative().max(100).optional(),
}).strict();

const repetitionSchema = z.object({
  trials: z.number().int().positive().max(100),
  max_infrastructure_retries: z.number().int().nonnegative().max(3),
}).strict();

const actionKey = (action: z.infer<typeof actionReferenceSchema>): string => `${action.kind}:${action.name}`;

const evalScenarioStructuralSchema = z.object({
  version: z.literal(EVAL_CONTRACT_VERSION),
  id: kebabIdSchema,
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1000),
  fixtures: z.array(fixtureSchema).max(20),
  prompts: z.object({
    agent_a: z.string().min(1).max(12_000),
    agent_b: z.string().min(1).max(12_000).optional(),
  }).strict(),
  actions: z.object({
    allowed: z.array(actionReferenceSchema).max(50),
    required: z.array(actionReferenceSchema).max(50),
    forbidden: z.array(actionReferenceSchema).max(50),
  }).strict(),
  budgets: budgetsSchema,
  repetition: repetitionSchema,
  gate_class: z.enum(["deterministic", "installation", "behavioral", "safety"]),
  scorer_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
}).strict();

export const evalScenarioSchema = evalScenarioStructuralSchema.superRefine((scenario, context) => {
  if (scenario.repetition.trials > scenario.budgets.max_trials) {
    context.addIssue({
      code: "custom",
      path: ["repetition", "trials"],
      message: "Repetition trials cannot exceed the trial budget",
    });
  }
  const allowed = new Set(scenario.actions.allowed.map(actionKey));
  const required = new Set(scenario.actions.required.map(actionKey));
  const forbidden = new Set(scenario.actions.forbidden.map(actionKey));
  for (const key of required) {
    if (!allowed.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["actions", "required"],
        message: `Required action ${key} must also be allowed`,
      });
    }
    if (forbidden.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["actions", "forbidden"],
        message: `Action ${key} cannot be both required and forbidden`,
      });
    }
  }
});

export const EVAL_SCENARIO_RUNTIME_CONTRACT = "artifactpass/eval-scenario@1" as const;

export const evalScenarioJsonSchema = {
  ...z.toJSONSchema(evalScenarioStructuralSchema),
  $id: "https://artifactpass.com/schemas/eval-scenario-version-1.json",
  title: "ArtifactPass portable eval scenario version 1",
  $comment: "Semantic validation requires the ArtifactPass runtime-contract keyword; ignoring it is unsupported.",
  "x-artifactpass-runtime-contract": EVAL_SCENARIO_RUNTIME_CONTRACT,
} as const;

export const validateEvalScenarioRuntimeContract = (contract: string, value: unknown): boolean =>
  contract === EVAL_SCENARIO_RUNTIME_CONTRACT && evalScenarioSchema.safeParse(value).success;

export type EvalScenario = z.infer<typeof evalScenarioSchema>;

const eventBaseSchema = z.object({
  version: z.literal(NORMALIZED_HOST_EVENT_VERSION),
  host: z.enum(["generic", "codex", "claude"]),
  sequence: z.number().int().nonnegative(),
});

export const HOST_TRACE_ERROR_CODES = [
  "invalid_json",
  "unknown_event",
  "truncated_stream",
  "oversized_stream",
  "oversized_line",
  "process_error",
  "process_timeout",
  "process_cancelled",
  "budget_exceeded",
] as const;

export const hostTraceErrorCodeSchema = z.enum(HOST_TRACE_ERROR_CODES);
export type HostTraceErrorCode = z.infer<typeof hostTraceErrorCodeSchema>;

export const normalizedHostEventSchema = z.discriminatedUnion("kind", [
  eventBaseSchema.extend({ kind: z.literal("session"), sessionId: z.string().min(1) }).strict(),
  eventBaseSchema.extend({ kind: z.literal("assistant_output"), text: z.string() }).strict(),
  eventBaseSchema.extend({ kind: z.literal("skill_selection"), skillName: z.string().min(1) }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("tool_call"),
    callId: z.string().min(1),
    hostToolName: z.string().min(1),
    serverName: z.string().min(1).optional(),
    toolName: z.string().min(1),
    arguments: z.unknown(),
  }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("tool_result"),
    callId: z.string().min(1),
    result: z.unknown(),
    isError: z.boolean(),
  }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("terminal"),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    message: z.string().optional(),
  }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("timing"),
    durationMilliseconds: z.number().int().nonnegative(),
  }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("process_exit"),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  }).strict(),
  eventBaseSchema.extend({
    kind: z.literal("infrastructure_error"),
    code: hostTraceErrorCodeSchema,
    message: z.string().min(1),
  }).strict(),
]);

export type NormalizedHostEvent = z.infer<typeof normalizedHostEventSchema>;

export const evalOutcomeSchema = z.enum([
  "pass",
  "behavior_failure",
  "safety_failure",
  "infrastructure_failure",
  "timeout",
  "incomplete",
  "skipped",
  "teardown_failure",
]);

export const evalResultSchema = z.object({
  version: z.literal(EVAL_RESULT_VERSION),
  run_id: z.uuid(),
  scenario_id: kebabIdSchema,
  candidate_sha256: sha256Schema,
  started_at: isoDateTimeSchema,
  completed_at: isoDateTimeSchema,
  trial_outcome: evalOutcomeSchema.exclude(["teardown_failure"]),
  outcome: evalOutcomeSchema,
  gate_class: z.enum(["deterministic", "installation", "behavioral", "safety"]),
  host_pair: z.object({
    agent_a: z.enum(["generic", "codex", "claude"]),
    agent_b: z.enum(["generic", "codex", "claude"]).optional(),
  }).strict(),
  infrastructure_code: z.string().min(1).optional(),
  teardown: z.enum(["not_required", "passed", "failed"]),
  observed_actions: z.array(actionReferenceSchema),
  failures: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict()),
}).strict().superRefine((result, context) => {
  if (Date.parse(result.completed_at) < Date.parse(result.started_at)) {
    context.addIssue({ code: "custom", path: ["completed_at"], message: "Completion must follow start" });
  }
  if (result.outcome === "infrastructure_failure" && result.infrastructure_code === undefined) {
    context.addIssue({
      code: "custom",
      path: ["infrastructure_code"],
      message: "Infrastructure failures require an infrastructure code",
    });
  }
});

export type EvalResult = z.infer<typeof evalResultSchema>;

export const evalReportSchema = z.object({
  version: z.literal(EVAL_REPORT_VERSION),
  run_id: z.uuid(),
  candidate: z.object({ sha256: sha256Schema }).strict(),
  receipt_version: z.number().int().positive(),
  scenario: z.object({
    id: kebabIdSchema,
    version: z.number().int().positive(),
    sha256: sha256Schema,
  }).strict(),
  scorer_version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  host: z.object({
    agent_a: z.enum(["generic", "codex", "claude"]),
    agent_b: z.enum(["generic", "codex", "claude"]).optional(),
    runtime: z.string().min(1),
    model: z.string().min(1).optional(),
  }).strict(),
  cohort: z.object({
    profile: z.enum(["deterministic", "smoke", "baseline", "release", "production"]),
    trial_index: z.number().int().positive(),
    trial_count: z.number().int().positive(),
  }).strict(),
  result: evalResultSchema,
  latency_ms: z.number().int().nonnegative(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    estimated_cost_usd: z.number().nonnegative().optional(),
  }).strict(),
  infrastructure_classification: z.string().min(1).optional(),
}).strict().superRefine((report, context) => {
  const identities: readonly [boolean, (string | number)[], string][] = [
    [report.result.run_id === report.run_id, ["result", "run_id"], "Nested result run ID must match the report"],
    [
      report.result.candidate_sha256 === report.candidate.sha256,
      ["result", "candidate_sha256"],
      "Nested result candidate must match the report",
    ],
    [
      report.result.scenario_id === report.scenario.id,
      ["result", "scenario_id"],
      "Nested result scenario must match the report",
    ],
    [
      report.result.host_pair.agent_a === report.host.agent_a,
      ["result", "host_pair", "agent_a"],
      "Nested Agent A host must match the report",
    ],
    [
      report.result.host_pair.agent_b === report.host.agent_b,
      ["result", "host_pair", "agent_b"],
      "Nested Agent B host must match the report",
    ],
  ];
  for (const [matches, path, message] of identities) {
    if (!matches) context.addIssue({ code: "custom", path, message });
  }
  if (report.cohort.trial_index > report.cohort.trial_count) {
    context.addIssue({
      code: "custom",
      path: ["cohort", "trial_index"],
      message: "Cohort trial index cannot exceed its trial count",
    });
  }
});

export type EvalReport = z.infer<typeof evalReportSchema>;
