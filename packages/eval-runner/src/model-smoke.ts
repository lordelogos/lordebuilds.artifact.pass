import type { EvalReport } from "./contracts";
import {
  BEHAVIOR_SCENARIO_IDS,
  runBehaviorScenario,
  type BehaviorScenarioId,
} from "./behavior-runner";
import { executionBudgetUsage } from "./budget-enforcement";
import { HostTraceError, type HostId } from "./hosts/host";
import { runModelHost, runtimeVersionForHost } from "./model-host";

export interface ModelSmokeResult {
  readonly status: "completed" | "authentication_blocked" | "infrastructure_blocked";
  readonly reports?: readonly EvalReport[];
  readonly artifacts?: readonly {
    readonly scenarioId: BehaviorScenarioId;
    readonly reportPath: string;
    readonly scorecardPath: string;
  }[];
  readonly reason?: string;
  readonly remainingBudgetUsd?: number;
}

export const runModelSmoke = async (options: {
  readonly host: HostId;
  readonly repositoryRoot: string;
  readonly scenarioIds?: readonly BehaviorScenarioId[];
  readonly maximumBudgetUsd: number;
}): Promise<ModelSmokeResult> => {
  if (!Number.isFinite(options.maximumBudgetUsd) || options.maximumBudgetUsd <= 0) {
    throw new Error("Smoke evals require a positive --maximum-budget-usd");
  }
  if (options.host === "codex") {
    return {
      status: "infrastructure_blocked",
      reason: "Codex smoke evals cannot claim a USD ceiling until the host exposes enforceable cost control",
    };
  }
  const credentialName = "ANTHROPIC_API_KEY";
  if (process.env[credentialName] === undefined) {
    return {
      status: "authentication_blocked",
      reason: `${credentialName} is required for an isolated, non-persistent ${options.host} smoke eval`,
    };
  }
  const runtimeVersion = await runtimeVersionForHost(options.host);
  if (runtimeVersion === undefined) {
    return {
      status: "infrastructure_blocked",
      reason: `${options.host} CLI is unavailable`,
    };
  }
  const reports: EvalReport[] = [];
  const artifacts: NonNullable<ModelSmokeResult["artifacts"]>[number][] = [];
  let remainingBudgetUsd = options.maximumBudgetUsd;
  const budgetedRunHost: typeof runModelHost = async (hostOptions) => {
    const allowedCost = Math.min(remainingBudgetUsd, hostOptions.maximumCostUsd ?? remainingBudgetUsd);
    if (allowedCost <= 0) throw new HostTraceError("budget_exceeded", "Smoke eval exhausted maximum_budget_usd");
    const account = (events: Parameters<typeof executionBudgetUsage>[0]): void => {
      remainingBudgetUsd -= executionBudgetUsage(events).costUsd;
    };
    try {
      const execution = await runModelHost({ ...hostOptions, maximumCostUsd: allowedCost });
      account(execution.events);
      return execution;
    } catch (error) {
      if (error instanceof HostTraceError && error.result !== undefined) account(error.result.events);
      throw error;
    }
  };
  for (const scenarioId of options.scenarioIds ?? BEHAVIOR_SCENARIO_IDS) {
    const result = await runBehaviorScenario({
      host: options.host,
      repositoryRoot: options.repositoryRoot,
      scenarioId,
      runtimeVersion,
      dependencies: { runHost: budgetedRunHost },
    });
    reports.push(result.report);
    artifacts.push({
      scenarioId,
      reportPath: result.reportPath,
      scorecardPath: result.scorecardPath,
    });
  }
  return { status: "completed", reports, artifacts, remainingBudgetUsd };
};
