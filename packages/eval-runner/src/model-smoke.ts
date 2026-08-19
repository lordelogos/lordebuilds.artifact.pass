import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evalScenarioSchema, type EvalReport } from "./contracts";
import { ClaudeEventParser } from "./hosts/claude";
import { CodexEventParser } from "./hosts/codex";
import { pickEnvironment, runHostCommand, type HostId } from "./hosts/host";
import { installCandidateIntoLocalEval } from "./install-lifecycle";
import { startLocalEvalEnvironment, type LocalEvalEnvironment } from "./local-environment";
import { writeEvalReport } from "./reporting";
import { outcomeWithTeardown, scoreShareBehavior, type ScoreFailure } from "./scoring";

const MODEL_BY_HOST = {
  codex: "gpt-5.4",
  claude: "claude-sonnet-4-6",
} as const;

interface InstalledMcpServer {
  readonly command: string;
  readonly args: readonly string[];
}

const readInstalledMcpServer = async (path: string): Promise<InstalledMcpServer> => {
  const configuration = JSON.parse(await readFile(path, "utf8")) as {
    readonly mcpServers?: Readonly<Record<string, { readonly command?: unknown; readonly args?: unknown }>>;
  };
  const server = configuration.mcpServers?.artifactpass;
  if (
    typeof server?.command !== "string" ||
    !Array.isArray(server.args) ||
    !server.args.every((argument) => typeof argument === "string")
  ) throw new Error("Installed ArtifactPass MCP configuration is invalid");
  return { command: server.command, args: server.args as string[] };
};

const quotedToml = (value: string): string => JSON.stringify(value);

const configureHost = async (options: {
  readonly host: HostId;
  readonly environment: LocalEvalEnvironment;
  readonly mcpConfigPath: string;
  readonly launcherPath: string;
}): Promise<{ readonly mcpConfigPath: string; readonly pluginRoot: string }> => {
  const server = await readInstalledMcpServer(options.mcpConfigPath);
  const pluginRoot = join(dirname(options.mcpConfigPath), "plugin");
  const wrappedServer = {
    command: process.execPath,
    args: [options.launcherPath, server.command, ...server.args],
  };
  if (options.host === "codex") {
    const codexHome = options.environment.homes.agentA;
    await cp(join(pluginRoot, "skills"), join(codexHome, "skills"), { recursive: true });
    await writeFile(join(codexHome, "config.toml"), [
      "[mcp_servers.artifactpass]",
      `command = ${quotedToml(wrappedServer.command)}`,
      `args = [${wrappedServer.args.map(quotedToml).join(", ")}]`,
      "",
    ].join("\n"), { mode: 0o600 });
    return { mcpConfigPath: options.mcpConfigPath, pluginRoot };
  }
  const claudeConfig = join(options.environment.root, "claude-mcp.json");
  await writeFile(claudeConfig, `${JSON.stringify({
    mcpServers: { artifactpass: wrappedServer },
  }, null, 2)}\n`, { mode: 0o600 });
  return { mcpConfigPath: claudeConfig, pluginRoot };
};

const hostArguments = (options: {
  readonly host: HostId;
  readonly workspace: string;
  readonly mcpConfigPath: string;
  readonly pluginRoot: string;
}): readonly string[] => options.host === "codex"
  ? [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--cd",
      options.workspace,
      "--model",
      MODEL_BY_HOST.codex,
      "-",
    ]
  : [
      "--print",
      "--bare",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      options.mcpConfigPath,
      "--plugin-dir",
      options.pluginRoot,
      "--allowedTools",
      "mcp__artifactpass__publish_artifact",
      "--model",
      MODEL_BY_HOST.claude,
      "--max-budget-usd",
      "1",
    ];

export interface ModelSmokeResult {
  readonly status: "completed" | "authentication_blocked";
  readonly report?: EvalReport;
  readonly reason?: string;
  readonly reportPath?: string;
  readonly scorecardPath?: string;
}

export const runModelSmoke = async (options: {
  readonly host: HostId;
  readonly repositoryRoot: string;
}): Promise<ModelSmokeResult> => {
  const credentialName = options.host === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (process.env[credentialName] === undefined) {
    return {
      status: "authentication_blocked",
      reason: `${credentialName} is required for an isolated, non-persistent ${options.host} smoke eval`,
    };
  }
  const startedAt = Date.now();
  const runId = randomUUID();
  const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
    join(options.repositoryRoot, "evals/scenarios/behavior/share-markdown.json"),
    "utf8",
  )));
  let environment: LocalEvalEnvironment | undefined;
  let teardownFailed = false;
  let failures: readonly ScoreFailure[] = [];
  let candidateSha256 = "0".repeat(64);
  let receiptVersion = 1;
  let events: Awaited<ReturnType<typeof runHostCommand>>["events"] = [];
  let infrastructureFailure = false;
  try {
    environment = await startLocalEvalEnvironment(options.repositoryRoot);
    const install = await installCandidateIntoLocalEval({
      environment,
      repositoryRoot: options.repositoryRoot,
      agent: "agent-a",
    });
    receiptVersion = install.receipt.receipt_version;
    const mcpConfigPath = install.receipt.portable_bundle.mcp_config;
    if (mcpConfigPath === undefined) throw new Error("Model smoke requires portable MCP registration");
    const fixture = scenario.fixtures[0];
    if (fixture === undefined) throw new Error("Model smoke scenario has no fixture");
    const targetPath = join(environment.workspaces.agentA, "artifact-share-smoke.md");
    await cp(join(options.repositoryRoot, fixture.path), targetPath);
    const currentFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
    const launcherPath = resolve(dirname(currentFile), "scrubbed-mcp-launcher.mjs");
    const configured = await configureHost({
      host: options.host,
      environment,
      mcpConfigPath,
      launcherPath,
    });
    const prompt = `${scenario.prompts.agent_a}\n\nDeclared fixture path: ${targetPath}`;
    const command = options.host === "codex" ? "codex" : "claude";
    const parser = options.host === "codex" ? new CodexEventParser() : new ClaudeEventParser();
    const execution = await runHostCommand({
      host: options.host,
      command,
      args: hostArguments({
        host: options.host,
        workspace: environment.workspaces.agentA,
        ...configured,
      }),
      cwd: environment.workspaces.agentA,
      env: pickEnvironment(process.env, ["PATH", credentialName], {
        HOME: environment.homes.agentA,
        ...(options.host === "codex"
          ? { CODEX_HOME: environment.homes.agentA }
          : { CLAUDE_CONFIG_DIR: environment.homes.agentA }),
        NO_COLOR: "1",
      }),
      timeoutMilliseconds: scenario.budgets.timeout_ms,
      parser,
      input: prompt,
    });
    events = execution.events;
    failures = scoreShareBehavior({
      events,
      evidence: {
        selectedSkills: events
          .filter((event) => event.kind === "skill_selection")
          .map((event) => event.kind === "skill_selection" ? event.skillName : ""),
        userInterventions: [],
      },
      expectedPath: targetPath,
      expectedExpirySeconds: 900,
    });
    candidateSha256 = createHash("sha256").update(await readFile(
      join(options.repositoryRoot, "plugins/artifactpass/dist/cli.mjs"),
    )).digest("hex");
  } catch (error) {
    infrastructureFailure = true;
    failures = [{
      code: "model_smoke_infrastructure",
      message: error instanceof Error ? error.message : "Model smoke infrastructure failed",
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
  const usageEvents = events.filter((event) => event.kind === "usage");
  const completedAt = Date.now();
  const report = {
    version: 1 as const,
    run_id: runId,
    candidate: { sha256: candidateSha256 },
    receipt_version: receiptVersion,
    scenario: { id: scenario.id, version: scenario.version },
    scorer_version: scenario.scorer_version,
    host: {
      agent_a: options.host,
      runtime: options.host,
      model: MODEL_BY_HOST[options.host],
    },
    cohort: { profile: "smoke" as const, trial_index: 1, trial_count: 1 },
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
      ...(infrastructureFailure ? { infrastructure_code: "model_smoke" } : {}),
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
    ...(infrastructureFailure ? { infrastructure_classification: "model_smoke" } : {}),
  } satisfies EvalReport;
  const paths = await writeEvalReport(join(options.repositoryRoot, "eval-results"), report);
  return {
    status: "completed",
    report,
    reportPath: paths.jsonPath,
    scorecardPath: paths.markdownPath,
  };
};
