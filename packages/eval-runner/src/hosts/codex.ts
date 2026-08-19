import {
  HostTraceError,
  NORMALIZED_HOST_EVENT_VERSION,
  type HostEventParser,
  type NormalizedHostEvent,
} from "./host";

export const CODEX_ADAPTER_COMPATIBILITY = {
  adapterVersion: 1,
  fixtureVersion: 1,
  testedCliVersion: "0.147.0",
  model: "gpt-5.4",
} as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" ? value : undefined;

export class CodexEventParser implements HostEventParser {
  readonly host = "codex" as const;
  #sequence = 0;

  parse(value: unknown): readonly NormalizedHostEvent[] {
    const event = record(value);
    const type = text(event?.type);
    if (event === undefined || type === undefined) throw this.#unknown();
    if (type === "thread.started") {
      const sessionId = text(event.thread_id);
      if (sessionId === undefined) throw this.#unknown();
      return [this.#event({ kind: "session", sessionId })];
    }
    if (type === "turn.started" || type === "item.updated") return [];
    if (type === "item.started" || type === "item.completed") {
      return this.#parseItem(type, event.item);
    }
    if (type === "turn.completed") {
      const usage = record(event.usage);
      const normalized: NormalizedHostEvent[] = [];
      if (usage !== undefined) {
        normalized.push(this.#event({
          kind: "usage",
          ...(number(usage.input_tokens) === undefined ? {} : { inputTokens: number(usage.input_tokens) }),
          ...(number(usage.cached_input_tokens) === undefined ? {} : { cachedInputTokens: number(usage.cached_input_tokens) }),
          ...(number(usage.output_tokens) === undefined ? {} : { outputTokens: number(usage.output_tokens) }),
        }));
      }
      normalized.push(this.#event({ kind: "terminal", status: "succeeded" }));
      return normalized;
    }
    if (type === "turn.failed") {
      const error = record(event.error);
      return [this.#event({
        kind: "terminal",
        status: "failed",
        ...(text(error?.message) === undefined ? {} : { message: text(error?.message) }),
      })];
    }
    if (type === "error") {
      return [this.#event({
        kind: "infrastructure_error",
        code: "process_error",
        message: text(event.message) ?? "Codex reported an error",
      })];
    }
    throw this.#unknown();
  }

  #parseItem(eventType: "item.started" | "item.completed", value: unknown): readonly NormalizedHostEvent[] {
    const item = record(value);
    const itemType = text(item?.type);
    const callId = text(item?.id);
    if (item === undefined || itemType === undefined || callId === undefined) throw this.#unknown();
    if (itemType === "agent_message") {
      if (eventType === "item.started") return [];
      const message = text(item.text);
      return message === undefined ? [] : [this.#event({ kind: "assistant_output", text: message })];
    }
    if (itemType === "mcp_tool_call") {
      const serverName = text(item.server);
      const toolName = text(item.tool);
      if (serverName === undefined || toolName === undefined) throw this.#unknown();
      if (eventType === "item.started") {
        return [this.#event({
          kind: "tool_call",
          callId,
          hostToolName: `${serverName}.${toolName}`,
          serverName,
          toolName,
          arguments: item.arguments ?? {},
        })];
      }
      return [this.#event({
        kind: "tool_result",
        callId,
        result: item.result ?? item.error ?? null,
        isError: item.error !== undefined && item.error !== null,
      })];
    }
    if (["reasoning", "command_execution", "file_change", "web_search"].includes(itemType)) return [];
    throw this.#unknown();
  }

  #event<T extends Omit<NormalizedHostEvent, "version" | "host" | "sequence">>(event: T): NormalizedHostEvent {
    return {
      version: NORMALIZED_HOST_EVENT_VERSION,
      host: this.host,
      sequence: this.#sequence++,
      ...event,
    } as NormalizedHostEvent;
  }

  #unknown(): HostTraceError {
    return new HostTraceError("unknown_event", "Codex emitted an unsupported event shape");
  }
}
