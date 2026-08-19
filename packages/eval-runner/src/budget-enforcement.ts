import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  evalScenarioSchema,
  type EvalScenario,
  type NormalizedHostEvent,
} from "./contracts";

export type CohortProfile = "smoke" | "baseline" | "release";

export const loadEvalScenario = async (path: string): Promise<EvalScenario> =>
  evalScenarioSchema.parse(JSON.parse(await readFile(path, "utf8")));

export const assertCohortTrialBudget = (
  profile: CohortProfile,
  trials: number,
  scenario: EvalScenario,
): void => {
  const minimum = profile === "baseline" ? 10 : profile === "release" ? 20 : 1;
  if (!Number.isInteger(trials) || trials < minimum || trials > scenario.budgets.max_trials) {
    throw new Error(
      `${profile} cohorts require ${minimum} through ${scenario.budgets.max_trials} trials for ${scenario.id}`,
    );
  }
};

export const assertFixtureByteBudget = (scenario: EvalScenario, bytes: number): void => {
  if (bytes > scenario.budgets.max_artifact_bytes) {
    throw new Error(`${scenario.id} fixture exceeds max_artifact_bytes=${scenario.budgets.max_artifact_bytes}`);
  }
};

export const assertScenarioFixtureBudgets = async (
  repositoryRoot: string,
  scenario: EvalScenario,
): Promise<void> => {
  for (const fixture of scenario.fixtures) {
    const metadata = await stat(join(repositoryRoot, fixture.path));
    assertFixtureByteBudget(scenario, metadata.size);
  }
};

export const countsAsModelStep = (event: NormalizedHostEvent): boolean =>
  event.kind === "assistant_output" || event.kind === "skill_selection" || event.kind === "tool_call";

export const executionBudgetUsage = (events: readonly NormalizedHostEvent[]): {
  readonly steps: number;
  readonly toolCalls: number;
  readonly costUsd: number;
} => ({
  steps: events.filter(countsAsModelStep).length,
  toolCalls: events.filter((event) => event.kind === "tool_call").length,
  costUsd: events.reduce(
    (sum, event) => sum + (event.kind === "usage" ? event.costUsd ?? 0 : 0),
    0,
  ),
});
