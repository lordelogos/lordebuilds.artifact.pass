import { resolve } from "node:path";

import { BEHAVIOR_SCENARIO_IDS, type BehaviorScenarioId } from "./behavior-runner";
import { runModelSmoke } from "./model-smoke";

const main = async (): Promise<void> => {
  const index = process.argv.indexOf("--host");
  const host = index < 0 ? undefined : process.argv[index + 1];
  if (host !== "codex" && host !== "claude") {
    throw new Error("Usage: pnpm eval:smoke --host <codex|claude> [--scenario <id|all>]");
  }
  const scenarioIndex = process.argv.indexOf("--scenario");
  const scenario = scenarioIndex < 0 ? "all" : process.argv[scenarioIndex + 1];
  if (scenario === undefined || (scenario !== "all" && !BEHAVIOR_SCENARIO_IDS.includes(scenario as BehaviorScenarioId))) {
    throw new Error(`--scenario must be all or one of: ${BEHAVIOR_SCENARIO_IDS.join(", ")}`);
  }
  const result = await runModelSmoke({
    host,
    repositoryRoot: resolve(process.cwd()),
    ...(scenario === "all" ? {} : { scenarioIds: [scenario as BehaviorScenarioId] }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "completed" || result.reports?.some((report) => report.result.outcome !== "pass")) {
    process.exitCode = 1;
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Model smoke failed"}\n`);
  process.exitCode = 1;
});
