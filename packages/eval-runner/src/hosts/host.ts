import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  NORMALIZED_HOST_EVENT_VERSION,
  type HostTraceErrorCode,
  type NormalizedHostEvent,
} from "../contracts";
import { countsAsModelStep } from "../budget-enforcement";

export { NORMALIZED_HOST_EVENT_VERSION };
export type { NormalizedHostEvent };
export const DEFAULT_MAX_TRACE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_TRACE_LINE_BYTES = 512 * 1024;

export type HostId = "codex" | "claude";
export type AuthorizationPlane = "model_provider" | "artifactpass" | "human_approval";
export type AuthorizationState =
  | "not_required"
  | "required"
  | "approved"
  | "denied"
  | "expired"
  | "blocked";

export type { HostTraceErrorCode };

export class HostTraceError extends Error {
  readonly code: HostTraceErrorCode;
  readonly result?: HostCommandResult;

  constructor(code: HostTraceErrorCode, message: string, result?: HostCommandResult) {
    super(message);
    this.name = "HostTraceError";
    this.code = code;
    if (result !== undefined) this.result = result;
  }
}

export interface HostEventParser {
  readonly host: HostId;
  parse(value: unknown): readonly NormalizedHostEvent[];
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export class BoundedJsonLineDecoder {
  readonly #maxBytes: number;
  readonly #maxLineBytes: number;
  #buffer = "";
  #bytes = 0;

  constructor(options: { readonly maxBytes?: number; readonly maxLineBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_TRACE_BYTES;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_TRACE_LINE_BYTES;
  }

  push(chunk: string): readonly unknown[] {
    this.#bytes += byteLength(chunk);
    if (this.#bytes > this.#maxBytes) {
      throw new HostTraceError("oversized_stream", "Host trace exceeded its byte limit");
    }
    this.#buffer += chunk;
    const values: unknown[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (byteLength(line) > this.#maxLineBytes) {
        throw new HostTraceError("oversized_line", "Host trace line exceeded its byte limit");
      }
      if (line.trim().length > 0) values.push(this.#parse(line));
      newlineIndex = this.#buffer.indexOf("\n");
    }
    if (byteLength(this.#buffer) > this.#maxLineBytes) {
      throw new HostTraceError("oversized_line", "Host trace line exceeded its byte limit");
    }
    return values;
  }

  finish(): readonly unknown[] {
    if (this.#buffer.length === 0) return [];
    const line = this.#buffer;
    this.#buffer = "";
    if (byteLength(line) > this.#maxLineBytes) {
      throw new HostTraceError("oversized_line", "Host trace line exceeded its byte limit");
    }
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      throw new HostTraceError("truncated_stream", "Host trace ended with an incomplete JSON event");
    }
  }

  #parse(line: string): unknown {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new HostTraceError("invalid_json", "Host trace contained invalid JSON");
    }
  }
}

export const parseHostChunks = (
  parser: HostEventParser,
  chunks: readonly string[],
  limits: { readonly maxBytes?: number; readonly maxLineBytes?: number } = {},
): readonly NormalizedHostEvent[] => {
  const decoder = new BoundedJsonLineDecoder(limits);
  const events: NormalizedHostEvent[] = [];
  for (const chunk of chunks) {
    for (const value of decoder.push(chunk)) events.push(...parser.parse(value));
  }
  for (const value of decoder.finish()) events.push(...parser.parse(value));
  return events;
};

export interface HostCommand {
  readonly host: HostId;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly parser: HostEventParser;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly terminationGraceMilliseconds?: number;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly maximumCostUsd?: number;
  readonly maxTraceBytes?: number;
  readonly maxTraceLineBytes?: number;
}

export interface HostCommandResult {
  readonly events: readonly NormalizedHostEvent[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

const killProcessGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

export const runHostCommand = async (options: HostCommand): Promise<HostCommandResult> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const decoder = new BoundedJsonLineDecoder({
      ...(options.maxTraceBytes === undefined ? {} : { maxBytes: options.maxTraceBytes }),
      ...(options.maxTraceLineBytes === undefined ? {} : { maxLineBytes: options.maxTraceLineBytes }),
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const events: NormalizedHostEvent[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    let failure: HostTraceError | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let steps = 0;
    let toolCalls = 0;
    let costUsd = 0;

    const result = (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): HostCommandResult => ({
      events,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
      signal: exitSignal,
    });

    const appendTerminalEvidence = (
      error: HostTraceError,
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): HostTraceError => {
      let sequence = events.length;
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: options.host,
        sequence: sequence++,
        kind: "infrastructure_error",
        code: error.code,
        message: error.message,
      });
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: options.host,
        sequence: sequence++,
        kind: "terminal",
        status: error.code === "process_timeout" || error.code === "process_cancelled"
          ? "cancelled"
          : "failed",
        message: error.message,
      });
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: options.host,
        sequence: sequence++,
        kind: "timing",
        durationMilliseconds: Date.now() - startedAt,
      });
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: options.host,
        sequence,
        kind: "process_exit",
        exitCode,
        signal: exitSignal,
      });
      return new HostTraceError(error.code, error.message, result(exitCode, exitSignal));
    };

    const stop = (error: HostTraceError): void => {
      if (failure !== undefined) return;
      failure = error;
      killProcessGroup(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        try {
          killProcessGroup(child.pid, "SIGKILL");
        } catch {
          // The close/error path preserves the original timeout or cancellation failure.
        }
      }, options.terminationGraceMilliseconds ?? 5_000);
    };
    const timeout = setTimeout(() => {
      stop(new HostTraceError("process_timeout", `Host process exceeded ${options.timeoutMilliseconds}ms`));
    }, options.timeoutMilliseconds);
    const abort = (): void => {
      stop(new HostTraceError("process_cancelled", "Host process was cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();

    const capture = (normalized: readonly NormalizedHostEvent[]): void => {
      for (const event of normalized) {
        if (failure !== undefined) return;
        if (countsAsModelStep(event)) steps += 1;
        if (event.kind === "tool_call") toolCalls += 1;
        if (event.kind === "usage") costUsd += event.costUsd ?? 0;
        events.push(event);
        if (options.maxSteps !== undefined && steps > options.maxSteps) {
          stop(new HostTraceError("budget_exceeded", `Host exceeded max_steps=${options.maxSteps}`));
          return;
        }
        if (options.maxToolCalls !== undefined && toolCalls > options.maxToolCalls) {
          stop(new HostTraceError("budget_exceeded", `Host exceeded max_tool_calls=${options.maxToolCalls}`));
          return;
        }
        if (options.maximumCostUsd !== undefined && costUsd > options.maximumCostUsd) {
          stop(new HostTraceError("budget_exceeded", `Host exceeded estimated_cost_usd=${options.maximumCostUsd}`));
          return;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(stdoutDecoder.write(chunk))) capture(options.parser.parse(value));
      } catch (error) {
        stop(error instanceof HostTraceError
          ? error
          : new HostTraceError("process_error", "Host trace parser failed"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > DEFAULT_MAX_TRACE_BYTES) {
        stop(new HostTraceError("oversized_stream", "Host stderr exceeded its byte limit"));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once("error", () => stop(new HostTraceError("process_error", "Host process failed to start")));
    child.stdin.on("error", () => stop(new HostTraceError("process_error", "Host process input failed")));
    child.stdin.end(options.input);
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (failure !== undefined) {
        reject(appendTerminalEvidence(failure, exitCode, exitSignal));
        return;
      }
      try {
        for (const value of decoder.push(stdoutDecoder.end())) capture(options.parser.parse(value));
        for (const value of decoder.finish()) capture(options.parser.parse(value));
      } catch (error) {
        const traceError = error instanceof HostTraceError
          ? error
          : new HostTraceError("process_error", "Host trace parser failed");
        reject(appendTerminalEvidence(traceError, exitCode, exitSignal));
        return;
      }
      const sequence = events.length;
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: options.host,
        sequence,
        kind: "timing",
        durationMilliseconds: Date.now() - startedAt,
      });
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: options.host,
        sequence: sequence + 1,
        kind: "process_exit",
        exitCode,
        signal: exitSignal,
      });
      resolve(result(exitCode, exitSignal));
    });
  });

export const pickEnvironment = (
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
  additions: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = { ...additions };
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};
