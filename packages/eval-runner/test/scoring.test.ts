import { describe, expect, it } from "vitest";

import { evalScenarioSchema, type NormalizedHostEvent } from "../src/contracts";
import { outcomeWithTeardown, scoreObservedActions, verifyExactBytes } from "../src/scoring";

const scenario = evalScenarioSchema.parse({
  version: 1,
  id: "scoring-fixture",
  title: "Scoring fixture",
  description: "A bounded scenario used to prove deterministic action scoring.",
  fixtures: [],
  prompts: { agent_a: "Run the declared action." },
  actions: {
    allowed: [{ kind: "mcp_tool", name: "publish_artifact" }],
    required: [{ kind: "mcp_tool", name: "publish_artifact" }],
    forbidden: [{ kind: "mcp_tool", name: "read_artifact" }],
  },
  budgets: {
    timeout_ms: 1000,
    max_steps: 2,
    max_tool_calls: 2,
    max_artifact_bytes: 100,
    max_trials: 1,
  },
  repetition: { trials: 1, max_infrastructure_retries: 0 },
  gate_class: "deterministic",
  scorer_version: "1.0.0",
});

const toolCall = (sequence: number, name: string): NormalizedHostEvent => ({
  version: 1,
  host: "generic",
  sequence,
  kind: "tool_call",
  callId: String(sequence),
  hostToolName: name,
  serverName: "artifactpass",
  toolName: name,
  arguments: {},
});

describe("deterministic scoring", () => {
  it("fails a forbidden action even when required behavior passed", () => {
    const score = scoreObservedActions(scenario, [
      toolCall(0, "publish_artifact"),
      toolCall(1, "read_artifact"),
    ]);
    expect(score.passed).toBe(false);
    expect(score.failures).toContainEqual(expect.objectContaining({ code: "forbidden_action", safety: true }));
  });

  it("checks bytes and checksum independently", () => {
    expect(verifyExactBytes({
      expected: Buffer.from("expected"),
      actual: Buffer.from("different"),
      expectedSha256: "a".repeat(64),
      actualSha256: "b".repeat(64),
    }).map((failure) => failure.code)).toEqual(["byte_mismatch", "checksum_mismatch"]);
  });

  it("preserves the trial outcome when teardown fails", () => {
    expect(outcomeWithTeardown("pass", true)).toEqual({
      trialOutcome: "pass",
      outcome: "teardown_failure",
    });
  });
});
