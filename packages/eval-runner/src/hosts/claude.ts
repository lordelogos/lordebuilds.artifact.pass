import {
  HostTraceError,
  NORMALIZED_HOST_EVENT_VERSION,
  type HostEventParser,
  type NormalizedHostEvent,
} from "./host";

export const CLAUDE_ADAPTER_COMPATIBILITY = {
  adapterVersion: 1,
  fixtureVersion: 1,
  testedCliVersion: "2.1.197",
  model: "claude-sonnet-4-6",
} as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" ? value : undefined;
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

const splitMcpToolName = (name: string): { readonly serverName?: string; readonly toolName: string } => {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match === null
    ? { toolName: name }
    : { serverName: match[1]!, toolName: match[2]! };
};

export class ClaudeEventParser implements HostEventParser {
  readonly host = "claude" as const;
  #sequence = 0;
  readonly #skillCallIds = new Set<string>();

  parse(value: unknown): readonly NormalizedHostEvent[] {
    const event = record(value);
    const type = text(event?.type);
    if (event === undefined || type === undefined) throw this.#unknown();
    if (type === "system" && event.subtype === "init") {
      const sessionId = text(event.session_id);
      if (sessionId === undefined) throw this.#unknown();
      return [this.#event({ kind: "session", sessionId })];
    }
    if (type === "assistant") return this.#assistant(event.message);
    if (type === "user") return this.#toolResults(event.message);
    if (type === "result") return this.#result(event);
    if (type === "stream_event" || type === "rate_limit_event" || type === "prompt_suggestion") return [];
    throw this.#unknown();
  }

  #assistant(value: unknown): readonly NormalizedHostEvent[] {
    const message = record(value);
    if (message === undefined) throw this.#unknown();
    const events: NormalizedHostEvent[] = [];
    for (const rawBlock of array(message.content)) {
      const block = record(rawBlock);
      if (block?.type === "text" && text(block.text) !== undefined) {
        events.push(this.#event({ kind: "assistant_output", text: text(block.text)! }));
      } else if (block?.type === "tool_use") {
        const callId = text(block.id);
        const hostToolName = text(block.name);
        if (callId === undefined || hostToolName === undefined) throw this.#unknown();
        if (hostToolName === "Skill") {
          const input = record(block.input);
          const rawSkillName = text(input?.skill);
          if (rawSkillName === undefined) throw this.#unknown();
          const withoutPlugin = rawSkillName.split("@")[0] ?? rawSkillName;
          const skillName = withoutPlugin.split(":").at(-1) ?? withoutPlugin;
          this.#skillCallIds.add(callId);
          events.push(this.#event({ kind: "skill_selection", skillName }));
          continue;
        }
        const names = splitMcpToolName(hostToolName);
        events.push(this.#event({
          kind: "tool_call",
          callId,
          hostToolName,
          ...(names.serverName === undefined ? {} : { serverName: names.serverName }),
          toolName: names.toolName,
          arguments: block.input ?? {},
        }));
      }
    }
    const usage = record(message.usage);
    if (usage !== undefined) {
      events.push(this.#event({
        kind: "usage",
        ...(number(usage.input_tokens) === undefined ? {} : { inputTokens: number(usage.input_tokens) }),
        ...(number(usage.cache_read_input_tokens) === undefined ? {} : { cachedInputTokens: number(usage.cache_read_input_tokens) }),
        ...(number(usage.output_tokens) === undefined ? {} : { outputTokens: number(usage.output_tokens) }),
      }));
    }
    return events;
  }

  #toolResults(value: unknown): readonly NormalizedHostEvent[] {
    const message = record(value);
    if (message === undefined) throw this.#unknown();
    const events: NormalizedHostEvent[] = [];
    for (const rawBlock of array(message.content)) {
      const block = record(rawBlock);
      if (block?.type !== "tool_result") continue;
      const callId = text(block.tool_use_id);
      if (callId === undefined) throw this.#unknown();
      if (this.#skillCallIds.delete(callId)) continue;
      events.push(this.#event({
        kind: "tool_result",
        callId,
        result: block.content ?? null,
        isError: block.is_error === true,
      }));
    }
    return events;
  }

  #result(event: Record<string, unknown>): readonly NormalizedHostEvent[] {
    const events: NormalizedHostEvent[] = [];
    const usage = record(event.usage);
    if (usage !== undefined || number(event.total_cost_usd) !== undefined) {
      events.push(this.#event({
        kind: "usage",
        ...(number(usage?.input_tokens) === undefined ? {} : { inputTokens: number(usage?.input_tokens) }),
        ...(number(usage?.cache_read_input_tokens) === undefined ? {} : { cachedInputTokens: number(usage?.cache_read_input_tokens) }),
        ...(number(usage?.output_tokens) === undefined ? {} : { outputTokens: number(usage?.output_tokens) }),
        ...(number(event.total_cost_usd) === undefined ? {} : { costUsd: number(event.total_cost_usd) }),
      }));
    }
    const failed = event.is_error === true || event.subtype !== "success";
    events.push(this.#event({
      kind: "terminal",
      status: failed ? "failed" : "succeeded",
      ...(failed && text(event.result) !== undefined ? { message: text(event.result) } : {}),
    }));
    return events;
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
    return new HostTraceError("unknown_event", "Claude emitted an unsupported event shape");
  }
}
