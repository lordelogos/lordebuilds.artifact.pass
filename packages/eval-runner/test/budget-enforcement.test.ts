import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertCohortTrialBudget,
  assertFixtureByteBudget,
  executionBudgetUsage,
  loadEvalScenario,
} from "../src/budget-enforcement";
import { modelArguments } from "../src/model-host";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("eval budget enforcement", () => {
  it("rejects release trial 21 for autonomous-handoff before the cohort launches", async () => {
    const scenario = await loadEvalScenario(join(
      repositoryRoot,
      "evals/scenarios/safety/autonomous-handoff.json",
    ));

    expect(() => assertCohortTrialBudget("release", 20, scenario)).not.toThrow();
    expect(() => assertCohortTrialBudget("release", 21, scenario)).toThrow(
      "release cohorts require 20 through 20 trials for autonomous-handoff",
    );
  });

  it("rejects a fixture larger than the selected scenario artifact budget", async () => {
    const scenario = await loadEvalScenario(join(
      repositoryRoot,
      "evals/scenarios/safety/autonomous-handoff.json",
    ));

    expect(() => assertFixtureByteBudget(scenario, scenario.budgets.max_artifact_bytes + 1)).toThrow(
      "autonomous-handoff fixture exceeds max_artifact_bytes=1048576",
    );
  });

  it("accounts for model steps, tool calls, and reported cost", () => {
    const usage = executionBudgetUsage([
      { version: 1, host: "claude", sequence: 0, kind: "session", sessionId: "session" },
      { version: 1, host: "claude", sequence: 1, kind: "skill_selection", skillName: "share-artifact" },
      {
        version: 1, host: "claude", sequence: 2, kind: "tool_call", callId: "call",
        hostToolName: "mcp__artifactpass__publish_artifact", toolName: "publish_artifact", arguments: {},
      },
      { version: 1, host: "claude", sequence: 3, kind: "assistant_output", text: "done" },
      { version: 1, host: "claude", sequence: 4, kind: "usage", costUsd: 0.25 },
    ]);

    expect(usage).toEqual({ steps: 3, toolCalls: 1, costUsd: 0.25 });
  });

  it("passes the remaining scenario cost to Claude's hard provider budget", () => {
    const arguments_ = modelArguments({
      host: "claude",
      workspace: "/eval/workspace",
      mcpConfigPath: "/eval/mcp.json",
      pluginRoot: "/eval/plugin",
      allowedTools: ["publish_artifact"],
      maximumCostUsd: 0.75,
    });

    expect(arguments_).toEqual(expect.arrayContaining(["--max-budget-usd", "0.75"]));
  });
});
