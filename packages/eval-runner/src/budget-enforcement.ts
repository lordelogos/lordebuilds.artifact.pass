import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  evalScenarioSchema,
  type EvalScenario,
  type NormalizedHostEvent,
} from "./contracts";
import type { HostId } from "./hosts/host";

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

export const assertProfileCostBudget = (
  profile: CohortProfile,
  maximumBudgetUsd: number | undefined,
): void => {
  if (maximumBudgetUsd === undefined) {
    throw new Error(`${profile} cohorts require an explicit --maximum-budget-usd`);
  }
  if (
    maximumBudgetUsd !== undefined &&
    (!Number.isFinite(maximumBudgetUsd) || maximumBudgetUsd <= 0)
  ) throw new Error("maximum_budget_usd must be a positive finite number");
};

export const assertHostCostBudgetSupport = (
  hosts: readonly HostId[],
  maximumCostUsd: number | undefined,
): void => {
  if (maximumCostUsd !== undefined && hosts.includes("codex")) {
    throw new Error(
      "Codex cohorts cannot claim a USD ceiling until the host exposes provider-enforced cost control or trustworthy cost telemetry",
    );
  }
};

export const assertSupportedInfrastructureRetryPolicy = (scenario: EvalScenario): void => {
  if (scenario.repetition.max_infrastructure_retries !== 0) {
    throw new Error(
      `${scenario.id} requests infrastructure retries, but ArtifactPass eval version 1 preserves failures without retrying them`,
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
