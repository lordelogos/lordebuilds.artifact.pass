import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeEventParser } from "./hosts/claude";
import { CodexEventParser } from "./hosts/codex";
import {
  HostTraceError,
  pickEnvironment,
  runHostCommand,
  type HostId,
  type NormalizedHostEvent,
} from "./hosts/host";

export type ProbeStatus = "supported" | "unsupported" | "authentication_blocked" | "approval_blocked";

export interface TraceProbeReport {
  readonly version: 1;
  readonly host: HostId;
  readonly status: ProbeStatus;
  readonly cliVersion?: string;
  readonly reason?: string;
  readonly evidence: {
    readonly sessionObserved: boolean;
    readonly exactToolCallObserved: boolean;
    readonly correlatedToolResultObserved: boolean;
    readonly independentServiceEvidenceObserved: boolean;
    readonly terminalStateObserved: boolean;
    readonly processExitObserved: boolean;
  };
}

const cliArguments = (host: HostId, root: string): readonly string[] => {
  const prompt = "Call the artifactpass_eval echo MCP tool exactly once with nonce artifactpass-trace-probe. Then state only that the probe completed.";
  if (host === "codex") {
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      root,
      prompt,
    ];
  }
  const mcpConfigPath = join(root, "claude-mcp.json");
  return [
    "--print",
    "--bare",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--allowedTools",
    "mcp__artifactpass_eval__echo",
    prompt,
  ];
};

const writeHostConfiguration = async (
  host: HostId,
  root: string,
  mcpServerPath: string,
  evidencePath: string,
): Promise<void> => {
  const server = {
    command: process.execPath,
    args: [mcpServerPath],
    env: { ARTIFACTPASS_EVAL_EVIDENCE_PATH: evidencePath },
  };
  if (host === "codex") {
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const quoted = (value: string): string => JSON.stringify(value);
    const config = [
      "[mcp_servers.artifactpass_eval]",
      `command = ${quoted(server.command)}`,
      `args = [${server.args.map(quoted).join(", ")}]`,
      "[mcp_servers.artifactpass_eval.env]",
      `ARTIFACTPASS_EVAL_EVIDENCE_PATH = ${quoted(evidencePath)}`,
      "",
    ].join("\n");
    await writeFile(join(codexHome, "config.toml"), config, { encoding: "utf8", mode: 0o600 });
    return;
  }
  await writeFile(
    join(root, "claude-mcp.json"),
    `${JSON.stringify({ mcpServers: { artifactpass_eval: server } }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

export const versionFor = async (command: string, options: {
  readonly args?: readonly string[];
  readonly timeoutMilliseconds?: number;
  readonly maxBytes?: number;
} = {}): Promise<string | undefined> => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveVersion) => {
    const child = spawn(command, [...(options.args ?? ["--version"])], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (version: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveVersion(version);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > (options.maxBytes ?? 64 * 1024)) {
        child.kill("SIGKILL");
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0
      ? Buffer.concat(chunks).toString("utf8").trim()
      : undefined));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, options.timeoutMilliseconds ?? 5_000);
  });
};

const reportEvidence = async (
  host: HostId,
  events: readonly NormalizedHostEvent[],
  evidencePath: string,
): Promise<TraceProbeReport["evidence"]> => {
  const call = events.find((event) => event.kind === "tool_call" &&
    event.serverName === "artifactpass_eval" && event.toolName === "echo" &&
    (event.arguments as { readonly nonce?: unknown }).nonce === "artifactpass-trace-probe");
  const callId = call?.kind === "tool_call" ? call.callId : undefined;
  const result = callId === undefined ? undefined : events.find((event) =>
    event.kind === "tool_result" && event.callId === callId);
  let serviceEvidence = false;
  try {
    const lines = (await readFile(evidencePath, "utf8")).trim().split("\n");
    serviceEvidence = lines.some((line) => {
      const value = JSON.parse(line) as { readonly tool?: unknown; readonly nonce?: unknown };
      return value.tool === "echo" && value.nonce === "artifactpass-trace-probe";
    });
  } catch {
    serviceEvidence = false;
  }
  return {
    sessionObserved: events.some((event) => event.kind === "session"),
    exactToolCallObserved: call !== undefined,
    correlatedToolResultObserved: result !== undefined,
    independentServiceEvidenceObserved: serviceEvidence,
    terminalStateObserved: events.some((event) => event.kind === "terminal"),
    processExitObserved: events.some((event) => event.kind === "process_exit"),
  };
};

const emptyEvidence = (): TraceProbeReport["evidence"] => ({
  sessionObserved: false,
  exactToolCallObserved: false,
  correlatedToolResultObserved: false,
  independentServiceEvidenceObserved: false,
  terminalStateObserved: false,
  processExitObserved: false,
});

export const runTraceProbe = async (host: HostId): Promise<TraceProbeReport> => {
  const command = host === "codex" ? "codex" : "claude";
  const credentialName = host === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const cliVersion = await versionFor(command);
  if (cliVersion === undefined) {
    return { version: 1, host, status: "unsupported", reason: `${command} is unavailable`, evidence: emptyEvidence() };
  }
  if (process.env[credentialName] === undefined) {
    return {
      version: 1,
      host,
      status: "authentication_blocked",
      cliVersion,
      reason: `${credentialName} is unavailable to an isolated non-persistent probe`,
      evidence: emptyEvidence(),
    };
  }

  const root = await mkdtemp(join(tmpdir(), "artifactpass-host-probe-"));
  await chmod(root, 0o700);
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const evidencePath = join(root, "service-evidence.jsonl");
    const currentFile = fileURLToPath(import.meta.url);
    const mcpServerPath = resolve(dirname(currentFile), "probe-mcp-server.mjs");
    await access(mcpServerPath, constants.R_OK);
    await writeHostConfiguration(host, root, mcpServerPath, evidencePath);
    const homeKey = host === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const homePath = host === "codex" ? join(root, "codex-home") : join(root, "claude-home");
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    const parser = host === "codex" ? new CodexEventParser() : new ClaudeEventParser();
    const result = await runHostCommand({
      host,
      command,
      args: cliArguments(host, workspace),
      cwd: workspace,
      env: pickEnvironment(process.env, ["PATH", credentialName], {
        HOME: homePath,
        [homeKey]: homePath,
        NO_COLOR: "1",
      }),
      timeoutMilliseconds: 120_000,
      parser,
    });
    const evidence = await reportEvidence(host, result.events, evidencePath);
    const supported = Object.values(evidence).every(Boolean) && result.exitCode === 0;
    return {
      version: 1,
      host,
      status: supported ? "supported" : "unsupported",
      cliVersion,
      ...(supported ? {} : { reason: "The host trace did not correlate every required probe event" }),
      evidence,
    };
  } catch (error) {
    return {
      version: 1,
      host,
      status: error instanceof HostTraceError && error.code === "process_cancelled"
        ? "approval_blocked"
        : "unsupported",
      cliVersion,
      reason: error instanceof Error ? error.message : "Host probe failed",
      evidence: emptyEvidence(),
    };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 2 });
  }
};

const parseHostArgument = (args: readonly string[]): HostId => {
  const index = args.indexOf("--host");
  const value = index < 0 ? undefined : args[index + 1];
  if (value !== "codex" && value !== "claude") {
    throw new Error("Usage: pnpm eval:host-probe --host <codex|claude>");
  }
  return value;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = parseHostArgument(process.argv.slice(2));
  const report = await runTraceProbe(host);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "supported") process.exitCode = 1;
}
