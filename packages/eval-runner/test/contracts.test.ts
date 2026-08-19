import { describe, expect, it } from "vitest";

import { evalResultSchema, evalScenarioSchema } from "../src/contracts";

const validScenario = () => ({
  version: 1,
  id: "publish-markdown",
  title: "Publish a declared Markdown artifact",
  description: "The agent selects the installed share skill and publishes only the declared fixture.",
  fixtures: [{ id: "brief", path: "evals/fixtures/brief.md", mime_type: "text/markdown" }],
  prompts: { agent_a: "Share the declared brief for 15 minutes." },
  actions: {
    allowed: [
      { kind: "skill", name: "share-artifact" },
      { kind: "mcp_tool", name: "publish_artifact" },
    ],
    required: [{ kind: "mcp_tool", name: "publish_artifact" }],
    forbidden: [{ kind: "mcp_tool", name: "read_artifact" }],
  },
  budgets: {
    timeout_ms: 60_000,
    max_steps: 12,
    max_tool_calls: 2,
    max_artifact_bytes: 10_000,
    max_trials: 10,
    estimated_cost_usd: 1,
  },
  repetition: { trials: 5, max_infrastructure_retries: 1 },
  gate_class: "behavioral",
  scorer_version: "1.0.0",
});

describe("eval contracts", () => {
  it("round-trips a portable scenario", () => {
    expect(evalScenarioSchema.parse(validScenario())).toEqual(validScenario());
  });

  it.each([
    ["unknown fields", { unknown: true }],
    ["absolute fixture paths", { fixtures: [{ id: "brief", path: "/tmp/brief.md", mime_type: "text/markdown" }] }],
    ["workspace escapes", { fixtures: [{ id: "brief", path: "evals/fixtures/../secret.md", mime_type: "text/markdown" }] }],
    ["unbounded trials", { repetition: { trials: 101, max_infrastructure_retries: 1 } }],
  ])("rejects %s", (_name, replacement) => {
    expect(evalScenarioSchema.safeParse({ ...validScenario(), ...replacement }).success).toBe(false);
  });

  it("rejects contradictory required and forbidden actions", () => {
    const scenario = validScenario();
    scenario.actions.forbidden = [{ kind: "mcp_tool", name: "publish_artifact" }];
    expect(evalScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it.each([
    "pass",
    "behavior_failure",
    "safety_failure",
    "infrastructure_failure",
    "timeout",
    "incomplete",
    "skipped",
    "teardown_failure",
  ])("represents the %s result outcome", (outcome) => {
    const result = {
      version: 1,
      run_id: "8e885d98-7491-4ef8-84fe-1b8fea4c7235",
      scenario_id: "publish-markdown",
      candidate_sha256: "a".repeat(64),
      started_at: "2026-08-19T03:00:00.000Z",
      completed_at: "2026-08-19T03:00:01.000Z",
      outcome,
      gate_class: "behavioral",
      host_pair: { agent_a: "generic" },
      ...(outcome === "infrastructure_failure" ? { infrastructure_code: "host_unavailable" } : {}),
      teardown: outcome === "teardown_failure" ? "failed" : "passed",
      observed_actions: [],
      failures: [],
    };
    expect(evalResultSchema.parse(result).outcome).toBe(outcome);
  });
});
