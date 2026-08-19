import { spawn } from "node:child_process";

export const NORMALIZED_HOST_EVENT_VERSION = 1 as const;
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

interface EventBase {
  readonly version: typeof NORMALIZED_HOST_EVENT_VERSION;
  readonly host: HostId;
  readonly sequence: number;
}

export type NormalizedHostEvent =
  | (EventBase & { readonly kind: "session"; readonly sessionId: string })
  | (EventBase & { readonly kind: "assistant_output"; readonly text: string })
  | (EventBase & {
      readonly kind: "tool_call";
      readonly callId: string;
      readonly hostToolName: string;
      readonly serverName?: string;
      readonly toolName: string;
      readonly arguments: unknown;
    })
  | (EventBase & {
      readonly kind: "tool_result";
      readonly callId: string;
      readonly result: unknown;
      readonly isError: boolean;
    })
  | (EventBase & {
      readonly kind: "usage";
      readonly inputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
    })
  | (EventBase & {
      readonly kind: "terminal";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly message?: string;
    })
  | (EventBase & { readonly kind: "timing"; readonly durationMilliseconds: number })
  | (EventBase & {
      readonly kind: "process_exit";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    })
  | (EventBase & {
      readonly kind: "infrastructure_error";
      readonly code: HostTraceErrorCode;
      readonly message: string;
    });

export type HostTraceErrorCode =
  | "invalid_json"
  | "unknown_event"
  | "truncated_stream"
  | "oversized_stream"
  | "oversized_line"
  | "process_error"
  | "process_timeout"
  | "process_cancelled";

export class HostTraceError extends Error {
  readonly code: HostTraceErrorCode;

  constructor(code: HostTraceErrorCode, message: string) {
    super(message);
    this.name = "HostTraceError";
    this.code = code;
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
  readonly signal?: AbortSignal;
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const decoder = new BoundedJsonLineDecoder();
    const events: NormalizedHostEvent[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    let failure: HostTraceError | undefined;

    const stop = (error: HostTraceError): void => {
      if (failure !== undefined) return;
      failure = error;
      killProcessGroup(child.pid, "SIGTERM");
    };
    const timeout = setTimeout(() => {
      stop(new HostTraceError("process_timeout", `Host process exceeded ${options.timeoutMilliseconds}ms`));
    }, options.timeoutMilliseconds);
    const abort = (): void => {
      stop(new HostTraceError("process_cancelled", "Host process was cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk.toString("utf8"))) events.push(...options.parser.parse(value));
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
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      try {
        for (const value of decoder.finish()) events.push(...options.parser.parse(value));
      } catch (error) {
        reject(error);
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
      resolve({
        events,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        signal: exitSignal,
      });
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
