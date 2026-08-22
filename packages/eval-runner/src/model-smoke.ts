import type { EvalReport } from "./contracts";
import {
  BEHAVIOR_SCENARIO_IDS,
  runBehaviorScenario,
  type BehaviorScenarioId,
} from "./behavior-runner";
import type { HostId } from "./hosts/host";
import { runtimeVersionForHost } from "./model-host";

export interface ModelSmokeResult {
  readonly status: "completed" | "authentication_blocked" | "infrastructure_blocked";
  readonly reports?: readonly EvalReport[];
  readonly artifacts?: readonly {
    readonly scenarioId: BehaviorScenarioId;
    readonly reportPath: string;
    readonly scorecardPath: string;
  }[];
  readonly reason?: string;
}

export const runModelSmoke = async (options: {
  readonly host: HostId;
  readonly repositoryRoot: string;
  readonly scenarioIds?: readonly BehaviorScenarioId[];
}): Promise<ModelSmokeResult> => {
  const credentialName = options.host === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
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
  for (const scenarioId of options.scenarioIds ?? BEHAVIOR_SCENARIO_IDS) {
    const result = await runBehaviorScenario({
      host: options.host,
      repositoryRoot: options.repositoryRoot,
      scenarioId,
      runtimeVersion,
    });
    reports.push(result.report);
    artifacts.push({
      scenarioId,
      reportPath: result.reportPath,
      scorecardPath: result.scorecardPath,
    });
  }
  return { status: "completed", reports, artifacts };
};
