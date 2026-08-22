import { join, resolve } from "node:path";

import { aggregateCohort } from "./aggregation";
import {
  BEHAVIOR_SCENARIO_IDS,
  runBehaviorScenario,
  type BehaviorScenarioId,
} from "./behavior-runner";
import {
  assertCohortTrialBudget,
  assertProfileCostBudget,
  assertScenarioFixtureBudgets,
  executionBudgetUsage,
  loadEvalScenario,
  type CohortProfile,
} from "./budget-enforcement";
import { HostTraceError, type HostId } from "./hosts/host";
import { runModelHandoffTrial } from "./model-handoff";
import { runModelHost, runtimeVersionForHost } from "./model-host";
import { writeCohortReport } from "./reporting";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const host = (name: string, required = true): HostId | undefined => {
  const value = argument(name);
  if (!required && value === undefined) return undefined;
  if (value !== "codex" && value !== "claude") throw new Error(`${name} must be codex or claude`);
  return value;
};

const main = async (): Promise<void> => {
  const agentA = host("--agent-a")!;
  const scenarioId = argument("--scenario") ?? "autonomous-handoff";
  const isBehaviorScenario = BEHAVIOR_SCENARIO_IDS.includes(scenarioId as BehaviorScenarioId);
  if (!isBehaviorScenario && scenarioId !== "autonomous-handoff") {
    throw new Error(`--scenario must be autonomous-handoff or one of: ${BEHAVIOR_SCENARIO_IDS.join(", ")}`);
  }
  const agentB = isBehaviorScenario ? agentA : host("--agent-b")!;
  const trials = Number(argument("--trials") ?? "1");
  const profile = argument("--profile") ?? "smoke";
  if (profile !== "smoke" && profile !== "baseline" && profile !== "release") {
    throw new Error("--profile must be smoke, baseline, or release");
  }
  const maximumBudgetValue = argument("--maximum-budget-usd");
  const maximumBudgetUsd = maximumBudgetValue === undefined ? undefined : Number(maximumBudgetValue);
  assertProfileCostBudget(profile as CohortProfile, maximumBudgetUsd);
  let remainingProfileCostUsd = maximumBudgetUsd;
  const repositoryRoot = resolve(process.cwd());
  const scenarioPath = isBehaviorScenario
    ? join(repositoryRoot, "evals/scenarios/behavior", `${scenarioId}.json`)
    : join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json");
  const scenario = await loadEvalScenario(scenarioPath);
  assertCohortTrialBudget(profile as CohortProfile, trials, scenario);
  await assertScenarioFixtureBudgets(repositoryRoot, scenario);
  const runtimeVersion = isBehaviorScenario ? await runtimeVersionForHost(agentA) : undefined;
  if (isBehaviorScenario && runtimeVersion === undefined) throw new Error(`${agentA} CLI is unavailable`);
  const reports = [];
  let remainingSteps = scenario.budgets.max_steps;
  let remainingToolCalls = scenario.budgets.max_tool_calls;
  const budgetedRunHost: typeof runModelHost = async (options) => {
    const scenarioCost = options.maximumCostUsd;
    const allowedCost = remainingProfileCostUsd === undefined
      ? scenarioCost
      : Math.min(remainingProfileCostUsd, scenarioCost ?? remainingProfileCostUsd);
    if (allowedCost !== undefined && allowedCost <= 0) {
      throw new HostTraceError("budget_exceeded", "Cohort exhausted maximum_budget_usd before launch");
    }
    if (remainingSteps <= 0) {
      throw new HostTraceError("budget_exceeded", "Trial exhausted max_steps before host launch");
    }
    const allowedSteps = Math.min(remainingSteps, options.maxSteps ?? remainingSteps);
    const allowedToolCalls = Math.min(remainingToolCalls, options.maxToolCalls ?? remainingToolCalls);
    const account = (events: Parameters<typeof executionBudgetUsage>[0]): void => {
      const usage = executionBudgetUsage(events);
      remainingSteps -= usage.steps;
      remainingToolCalls -= usage.toolCalls;
      if (remainingProfileCostUsd !== undefined) remainingProfileCostUsd -= usage.costUsd;
    };
    try {
      const execution = await runModelHost({
        ...options,
        maxSteps: allowedSteps,
        maxToolCalls: allowedToolCalls,
        ...(allowedCost === undefined ? {} : { maximumCostUsd: allowedCost }),
      });
      account(execution.events);
      return execution;
    } catch (error) {
      if (error instanceof HostTraceError && error.result !== undefined) account(error.result.events);
      throw error;
    }
  };
  for (let trial = 1; trial <= trials; trial += 1) {
    remainingSteps = scenario.budgets.max_steps;
    remainingToolCalls = scenario.budgets.max_tool_calls;
    const result = isBehaviorScenario
      ? await runBehaviorScenario({
          host: agentA,
          repositoryRoot,
          scenarioId: scenarioId as BehaviorScenarioId,
          runtimeVersion: runtimeVersion!,
          profile,
          trialIndex: trial,
          trialCount: trials,
          dependencies: { runHost: budgetedRunHost },
        })
      : await runModelHandoffTrial({
          agentA,
          agentB,
          repositoryRoot,
          profile,
          trialIndex: trial,
          trialCount: trials,
          dependencies: { runHost: budgetedRunHost },
        });
    const report = "status" in result
      ? result.status === "completed" ? result.report : undefined
      : result.report;
    if (report === undefined) {
      throw new Error("reason" in result ? result.reason ?? "Model cohort blocked" : "Model cohort blocked");
    }
    reports.push(report);
    process.stderr.write(
      `ArtifactPass ${scenarioId} ${agentA}${isBehaviorScenario ? "" : ` -> ${agentB}`} trial ${trial}/${trials}: ${report.result.outcome}\n`,
    );
  }
  const cohort = aggregateCohort(reports);
  const paths = await writeCohortReport(join(repositoryRoot, "eval-results", `${profile}s`), cohort);
  process.stdout.write(`${JSON.stringify({
    cohort,
    ...paths,
    remaining_budget_usd: remainingProfileCostUsd,
    release_qualification: "Run pnpm eval:matrix; behavioral success does not override containment, identity, or skill-observability blockers.",
  }, null, 2)}\n`);
  const failed = cohort.gate_class === "behavioral"
    ? !cohort.eligible_for_threshold
    : cohort.outcomes.pass !== cohort.total_trials || cohort.hard_failures.length > 0;
  if (failed) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Model cohort failed"}\n`);
  process.exitCode = 1;
});
