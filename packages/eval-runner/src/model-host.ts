import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ClaudeEventParser } from "./hosts/claude";
import { CodexEventParser } from "./hosts/codex";
import { pickEnvironment, runHostCommand, type HostCommandResult, type HostId } from "./hosts/host";
import type { LocalEvalEnvironment } from "./local-environment";
import { versionFor } from "./runtime-version";

export const MODEL_BY_HOST = {
  codex: "gpt-5.4",
  claude: "claude-sonnet-4-6",
} as const;

export const runtimeVersionForHost = async (host: HostId): Promise<string | undefined> => {
  const raw = await versionFor(host === "codex" ? "codex" : "claude");
  return raw === undefined ? undefined : /\d+\.\d+\.\d+/u.exec(raw)?.[0];
};

const readInstalledMcpServer = async (path: string): Promise<{
  readonly command: string;
  readonly args: readonly string[];
}> => {
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

export const configureModelHost = async (options: {
  readonly host: HostId;
  readonly agent: "agent-a" | "agent-b";
  readonly environment: LocalEvalEnvironment;
  readonly mcpConfigPath: string;
  readonly launcherPath: string;
  readonly allowedTools: readonly ("publish_artifact" | "read_artifact")[];
}): Promise<{ readonly mcpConfigPath: string; readonly pluginRoot: string; readonly home: string }> => {
  const server = await readInstalledMcpServer(options.mcpConfigPath);
  const pluginRoot = join(dirname(options.mcpConfigPath), "plugin");
  const home = options.agent === "agent-a" ? options.environment.homes.agentA : options.environment.homes.agentB;
  const wrappedServer = {
    command: process.execPath,
    args: [
      options.launcherPath,
      "--allowed-tools",
      JSON.stringify(options.allowedTools),
      "--",
      server.command,
      ...server.args,
    ],
  };
  if (options.host === "codex") {
    await cp(join(pluginRoot, "skills"), join(home, "skills"), { recursive: true });
    await writeFile(join(home, "config.toml"), [
      "[mcp_servers.artifactpass]",
      `command = ${quotedToml(wrappedServer.command)}`,
      `args = [${wrappedServer.args.map(quotedToml).join(", ")}]`,
      "",
    ].join("\n"), { mode: 0o600 });
    return { mcpConfigPath: options.mcpConfigPath, pluginRoot, home };
  }
  const claudeConfig = join(options.environment.root, `${options.agent}-claude-mcp.json`);
  await writeFile(claudeConfig, `${JSON.stringify({
    mcpServers: { artifactpass: wrappedServer },
  }, null, 2)}\n`, { mode: 0o600 });
  return { mcpConfigPath: claudeConfig, pluginRoot, home };
};

export const CODEX_DISABLED_CAPABILITIES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "shell_tool",
  "standalone_web_search",
  "unified_exec",
  "view_image",
] as const;

export const modelArguments = (options: {
  readonly host: HostId;
  readonly workspace: string;
  readonly mcpConfigPath: string;
  readonly pluginRoot: string;
  readonly allowedTools: readonly ("publish_artifact" | "read_artifact")[];
  readonly maximumCostUsd?: number;
}): readonly string[] => {
  const claudeTools = ["Skill", ...options.allowedTools.map((tool) => `mcp__artifactpass__${tool}`)];
  return options.host === "codex"
    ? [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--ignore-rules",
      ...CODEX_DISABLED_CAPABILITIES.flatMap((feature) => ["--disable", feature]),
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
      "--tools",
      claudeTools.join(","),
      "--allowedTools",
      ...claudeTools,
      "--permission-mode",
      "dontAsk",
      "--model",
      MODEL_BY_HOST.claude,
      "--max-budget-usd",
      String(options.maximumCostUsd ?? 1),
    ];
};

export const runModelHost = async (options: {
  readonly host: HostId;
  readonly agent: "agent-a" | "agent-b";
  readonly environment: LocalEvalEnvironment;
  readonly mcpConfigPath: string;
  readonly launcherPath: string;
  readonly prompt: string;
  readonly allowedTools: readonly ("publish_artifact" | "read_artifact")[];
  readonly timeoutMilliseconds: number;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly maximumCostUsd?: number;
}): Promise<HostCommandResult> => {
  const configured = await configureModelHost({
    ...options,
    allowedTools: options.allowedTools,
  });
  const workspace = options.agent === "agent-a"
    ? options.environment.workspaces.agentA
    : options.environment.workspaces.agentB;
  const credentialName = options.host === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  return runHostCommand({
    host: options.host,
    command: options.host === "codex" ? "codex" : "claude",
    args: modelArguments({
      host: options.host,
      workspace,
      mcpConfigPath: configured.mcpConfigPath,
      pluginRoot: configured.pluginRoot,
      allowedTools: options.allowedTools,
      ...(options.maximumCostUsd === undefined ? {} : { maximumCostUsd: options.maximumCostUsd }),
    }),
    cwd: workspace,
    env: pickEnvironment(process.env, ["PATH", credentialName], {
      HOME: configured.home,
      ...(options.host === "codex" ? { CODEX_HOME: configured.home } : { CLAUDE_CONFIG_DIR: configured.home }),
      NO_COLOR: "1",
    }),
    timeoutMilliseconds: options.timeoutMilliseconds,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
    ...(options.maximumCostUsd === undefined ? {} : { maximumCostUsd: options.maximumCostUsd }),
    parser: options.host === "codex" ? new CodexEventParser() : new ClaudeEventParser(),
    input: options.prompt,
  });
};

export const modelExecutionFailure = (execution: HostCommandResult): string | undefined => {
  const terminalEvents = execution.events.filter((event) => event.kind === "terminal");
  if (
    execution.exitCode !== 0 ||
    execution.signal !== null ||
    execution.events.some((event) => event.kind === "infrastructure_error") ||
    terminalEvents.length !== 1 ||
    terminalEvents[0]?.status !== "succeeded"
  ) return "Model host did not complete with one successful terminal event and a clean process exit";
  return undefined;
};
