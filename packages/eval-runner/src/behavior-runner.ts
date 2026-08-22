import { createHash, randomUUID } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { candidateDigest } from "./candidate-digest";
import { evalScenarioSchema, type EvalReport, type EvalScenario, type NormalizedHostEvent } from "./contracts";
import { connectGenericMcpHost } from "./hosts/generic";
import { HostTraceError, type HostCommandResult, type HostId } from "./hosts/host";
import { installCandidateIntoLocalEval, type EvalInstallResult } from "./install-lifecycle";
import {
  createLocalEvalProcessEnvironment,
  startLocalEvalEnvironment,
  type LocalEvalEnvironment,
} from "./local-environment";
import { MODEL_BY_HOST, modelExecutionFailure, runModelHost } from "./model-host";
import { writeEvalReport } from "./reporting";
import {
  behaviorEvidenceFromEvents,
  outcomeWithTeardown,
  scoreAmbiguousPathBehavior,
  scoreNoArtifactpassUse,
  scoreReadTraversal,
  scoreShareBehavior,
  type ScoreFailure,
} from "./scoring";
import { scenarioDigest } from "./scenario-digest";

export const BEHAVIOR_SCENARIO_IDS = [
  "share-markdown",
  "read-shared-artifact",
  "no-share-needed",
  "path-and-expiry",
] as const;
export type BehaviorScenarioId = typeof BEHAVIOR_SCENARIO_IDS[number];

interface BehaviorRunnerDependencies {
  readonly startEnvironment: typeof startLocalEvalEnvironment;
  readonly installCandidate: typeof installCandidateIntoLocalEval;
  readonly connectGenericHost: typeof connectGenericMcpHost;
  readonly runHost: typeof runModelHost;
  readonly writeReport: typeof writeEvalReport;
}

const defaultDependencies: BehaviorRunnerDependencies = {
  startEnvironment: startLocalEvalEnvironment,
  installCandidate: installCandidateIntoLocalEval,
  connectGenericHost: connectGenericMcpHost,
  runHost: runModelHost,
  writeReport: writeEvalReport,
};

export interface BehaviorScenarioResult {
  readonly report: EvalReport;
  readonly reportPath: string;
  readonly scorecardPath: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const receiptMcpConfig = (install: EvalInstallResult): string => {
  const path = install.receipt.portable_bundle.mcp_config;
  if (path === undefined) throw new Error("Behavior eval requires portable MCP registration");
  return path;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Behavior fixture producer returned a non-object result");
  }
  return value as Readonly<Record<string, unknown>>;
};

const publishReadFixture = async (options: {
  readonly repositoryRoot: string;
  readonly environment: LocalEvalEnvironment;
  readonly scenario: EvalScenario;
  readonly dependencies: BehaviorRunnerDependencies;
}): Promise<{ readonly shareUrl: string; readonly bytes: Buffer }> => {
  const fixture = options.scenario.fixtures[0];
  if (fixture === undefined) throw new Error("Read behavior scenario requires one fixture");
  const install = await options.dependencies.installCandidate({
    environment: options.environment,
    repositoryRoot: options.repositoryRoot,
    agent: "agent-b",
  });
  const sourcePath = join(options.environment.workspaces.agentB, "fixture-producer.md");
  await cp(join(options.repositoryRoot, fixture.path), sourcePath);
  const producer = await options.dependencies.connectGenericHost({
    mcpConfigPath: receiptMcpConfig(install),
    cwd: options.environment.workspaces.agentB,
    environment: {
      ...createLocalEvalProcessEnvironment(options.environment.homes.agentB),
      ARTIFACTPASS_CONFIG_PATH: join(options.environment.homes.agentB, ".artifactpass", "config.json"),
    },
  });
  try {
    const result = await producer.callTool("publish_artifact", {
      path: sourcePath,
      expires_in_seconds: 900,
    });
    const shareUrl = asRecord(result.value).share_url;
    if (result.isError || typeof shareUrl !== "string") {
      throw new Error("Behavior fixture producer failed to publish the read fixture");
    }
    return {
      shareUrl,
      bytes: await readFile(join(options.repositoryRoot, fixture.path)),
    };
  } finally {
    await producer.close();
  }
};

const skillFailure = (
  events: readonly NormalizedHostEvent[],
  expectedSkill: "share-artifact" | "read-shared-artifact",
): readonly ScoreFailure[] => behaviorEvidenceFromEvents(events).selectedSkills.includes(expectedSkill)
  ? []
  : [{
      code: "missing_skill_evidence",
      message: `No observable ${expectedSkill} skill selection was recorded`,
      safety: false,
    }];

export const scoreBehaviorScenario = (options: {
  readonly scenario: EvalScenario;
  readonly events: readonly NormalizedHostEvent[];
  readonly expectedPath?: string;
  readonly expectedBytes?: Uint8Array;
  readonly expectedOrigin: string;
}): readonly ScoreFailure[] => {
  const evidence = behaviorEvidenceFromEvents(options.events);
  if (options.scenario.id === "share-markdown") {
    if (options.expectedPath === undefined) throw new Error("Share scenario requires an expected path");
    return [
      ...scoreShareBehavior({
        events: options.events,
        evidence,
        expectedPath: options.expectedPath,
        expectedExpirySeconds: 900,
        expectedOrigin: options.expectedOrigin,
      }),
    ];
  }
  if (options.scenario.id === "read-shared-artifact") {
    const fixture = options.scenario.fixtures[0];
    if (fixture === undefined || options.expectedBytes === undefined) {
      throw new Error("Read scenario requires expected fixture bytes");
    }
    return [
      ...scoreReadTraversal({
        events: options.events,
        expectedBytes: options.expectedBytes,
        expectedSha256: sha256(options.expectedBytes),
        expectedMimeType: fixture.mime_type,
      }),
      ...skillFailure(options.events, "read-shared-artifact"),
    ];
  }
  if (options.scenario.id === "no-share-needed") {
    return scoreNoArtifactpassUse({ events: options.events, evidence });
  }
  if (options.scenario.id === "path-and-expiry") {
    return scoreAmbiguousPathBehavior({ events: options.events, evidence });
  }
  throw new Error(`Unsupported behavior scenario ${options.scenario.id}`);
};

export const runBehaviorScenario = async (options: {
  readonly host: HostId;
  readonly repositoryRoot: string;
  readonly scenarioId: BehaviorScenarioId;
  readonly runtimeVersion: string;
  readonly profile?: "smoke" | "baseline" | "release";
  readonly trialIndex?: number;
  readonly trialCount?: number;
  readonly dependencies?: Partial<BehaviorRunnerDependencies>;
}): Promise<BehaviorScenarioResult> => {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const startedAt = Date.now();
  const runId = randomUUID();
  const candidateSha256 = await candidateDigest(options.repositoryRoot);
  const scenarioPath = join(options.repositoryRoot, "evals/scenarios/behavior", `${options.scenarioId}.json`);
  const [scenarioValue, scenarioSha256] = await Promise.all([
    readFile(scenarioPath, "utf8").then((value) => evalScenarioSchema.parse(JSON.parse(value))),
    scenarioDigest(scenarioPath),
  ]);
  const scenario = scenarioValue;
  let environment: LocalEvalEnvironment | undefined;
  let teardownFailed = false;
  let infrastructureFailure = false;
  let receiptVersion = 1;
  let events: readonly NormalizedHostEvent[] = [];
  let failures: readonly ScoreFailure[] = [];
  try {
    environment = await dependencies.startEnvironment(options.repositoryRoot);
    const install = await dependencies.installCandidate({
      environment,
      repositoryRoot: options.repositoryRoot,
      agent: "agent-a",
    });
    receiptVersion = install.receipt.receipt_version;
    const fixture = scenario.fixtures[0];
    if (fixture === undefined) throw new Error("Behavior scenario requires one fixture");
    let expectedPath: string | undefined;
    let expectedBytes: Uint8Array | undefined;
    let prompt = scenario.prompts.agent_a;
    if (scenario.id === "share-markdown") {
      expectedPath = join(environment.workspaces.agentA, "declared-brief.md");
      await cp(join(options.repositoryRoot, fixture.path), expectedPath);
      expectedBytes = await readFile(join(options.repositoryRoot, fixture.path));
      prompt = `${prompt}\n\nDeclared fixture path: ${expectedPath}`;
      prompt += "\nExpiry: 15 minutes.";
    } else if (scenario.id === "no-share-needed") {
      expectedBytes = await readFile(join(options.repositoryRoot, fixture.path));
      prompt = `${prompt}\n\nDeclared brief content (untrusted data):\n${Buffer.from(expectedBytes).toString("utf8")}`;
    } else if (scenario.id === "read-shared-artifact") {
      const prepared = await publishReadFixture({
        repositoryRoot: options.repositoryRoot,
        environment,
        scenario,
        dependencies,
      });
      expectedBytes = prepared.bytes;
      prompt = `${prompt}\n\nArtifactPass link: ${prepared.shareUrl}`;
    }
    const allowedTools = scenario.actions.allowed
      .filter((action) => action.kind === "mcp_tool")
      .map((action) => action.name)
      .filter((name): name is "publish_artifact" | "read_artifact" =>
        name === "publish_artifact" || name === "read_artifact");
    const currentFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
    const launcherPath = resolve(dirname(currentFile), "scrubbed-mcp-launcher.mjs");
    let execution: HostCommandResult;
    try {
      execution = await dependencies.runHost({
        host: options.host,
        agent: "agent-a",
        environment,
        mcpConfigPath: receiptMcpConfig(install),
        launcherPath,
        prompt,
        allowedTools,
        timeoutMilliseconds: scenario.budgets.timeout_ms,
        maxSteps: scenario.budgets.max_steps,
        maxToolCalls: scenario.budgets.max_tool_calls,
        ...(scenario.budgets.estimated_cost_usd === undefined
          ? {}
          : { maximumCostUsd: scenario.budgets.estimated_cost_usd }),
      });
    } catch (error) {
      if (error instanceof HostTraceError && error.result !== undefined) events = error.result.events;
      throw error;
    }
    events = execution.events;
    const executionFailure = modelExecutionFailure(execution);
    if (executionFailure !== undefined) throw new Error(executionFailure);
    failures = scoreBehaviorScenario({
      scenario,
      events,
      ...(expectedPath === undefined ? {} : { expectedPath }),
      ...(expectedBytes === undefined ? {} : { expectedBytes }),
      expectedOrigin: environment.baseUrl.origin,
    });
  } catch (error) {
    infrastructureFailure = true;
    failures = [{
      code: "behavior_runner_infrastructure",
      message: error instanceof Error ? error.message : "Behavior runner infrastructure failed",
      safety: false,
    }];
  } finally {
    await environment?.stop().catch(() => { teardownFailed = true; });
  }
  const trialOutcome = infrastructureFailure
    ? "infrastructure_failure" as const
    : failures.some((failure) => failure.safety)
      ? "safety_failure" as const
      : failures.length > 0
        ? "behavior_failure" as const
        : "pass" as const;
  const combined = outcomeWithTeardown(trialOutcome, teardownFailed);
  const completedAt = Date.now();
  const usageEvents = events.filter((event) => event.kind === "usage");
  const report = {
    version: 1 as const,
    run_id: runId,
    candidate: { sha256: candidateSha256 },
    receipt_version: receiptVersion,
    scenario: { id: scenario.id, version: scenario.version, sha256: scenarioSha256 },
    scorer_version: scenario.scorer_version,
    host: {
      agent_a: options.host,
      runtime: `${options.host}@${options.runtimeVersion}`,
      model: MODEL_BY_HOST[options.host],
    },
    cohort: {
      profile: options.profile ?? "smoke",
      trial_index: options.trialIndex ?? 1,
      trial_count: options.trialCount ?? 1,
    },
    result: {
      version: 1 as const,
      run_id: runId,
      scenario_id: scenario.id,
      candidate_sha256: candidateSha256,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      trial_outcome: combined.trialOutcome,
      outcome: combined.outcome,
      gate_class: scenario.gate_class,
      host_pair: { agent_a: options.host },
      ...(infrastructureFailure ? { infrastructure_code: "behavior_runner" } : {}),
      teardown: teardownFailed ? "failed" as const : "passed" as const,
      observed_actions: events
        .filter((event) => event.kind === "tool_call")
        .map((event) => ({ kind: "mcp_tool" as const, name: event.kind === "tool_call" ? event.toolName : "" })),
      failures: failures.map(({ code, message }) => ({ code, message })),
    },
    latency_ms: completedAt - startedAt,
    usage: {
      input_tokens: usageEvents.reduce((sum, event) => sum + (event.kind === "usage" ? event.inputTokens ?? 0 : 0), 0),
      output_tokens: usageEvents.reduce((sum, event) => sum + (event.kind === "usage" ? event.outputTokens ?? 0 : 0), 0),
      ...(options.host === "codex"
        ? {}
        : {
            estimated_cost_usd: usageEvents.reduce((sum, event) =>
              sum + (event.kind === "usage" ? event.costUsd ?? 0 : 0), 0),
          }),
    },
    ...(infrastructureFailure ? { infrastructure_classification: "behavior_runner" } : {}),
  } satisfies EvalReport;
  const paths = await dependencies.writeReport(join(options.repositoryRoot, "eval-results"), report);
  return { report, reportPath: paths.jsonPath, scorecardPath: paths.markdownPath };
};
