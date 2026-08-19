import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ClaudeEventParser } from "../src/hosts/claude";
import { CodexEventParser } from "../src/hosts/codex";
import {
  HostTraceError,
  parseHostChunks,
  runHostCommand,
} from "../src/hosts/host";
import { modelExecutionFailure } from "../src/model-host";
import { versionFor } from "../src/runtime-version";

const fixture = async (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`./fixtures/host-streams/${name}`, import.meta.url)), "utf8");

describe("host adapters", () => {
  it("normalizes a Codex JSONL trace with correlated MCP evidence", async () => {
    const events = parseHostChunks(new CodexEventParser(), [await fixture("codex-success.jsonl")]);
    expect(events.map((event) => event.kind)).toEqual([
      "session",
      "tool_call",
      "tool_result",
      "assistant_output",
      "usage",
      "terminal",
    ]);
    expect(events.find((event) => event.kind === "tool_call")).toMatchObject({
      callId: "call-1",
      serverName: "artifactpass_eval",
      toolName: "echo",
      arguments: { nonce: "artifactpass-trace-probe" },
    });
    expect(events.find((event) => event.kind === "tool_result")).toMatchObject({
      callId: "call-1",
      isError: false,
    });
  });

  it("normalizes a Claude stream trace into the same categories", async () => {
    const events = parseHostChunks(new ClaudeEventParser(), [await fixture("claude-success.jsonl")]);
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set([
      "session",
      "skill_selection",
      "tool_call",
      "tool_result",
      "assistant_output",
      "usage",
      "terminal",
    ]));
    expect(events.find((event) => event.kind === "tool_call")).toMatchObject({
      callId: "toolu_1",
      hostToolName: "mcp__artifactpass_eval__echo",
      serverName: "artifactpass_eval",
      toolName: "echo",
    });
    expect(events.find((event) => event.kind === "skill_selection")).toMatchObject({
      skillName: "share-artifact",
    });
  });

  it.each([
    ["unknown event", "{\"type\":\"new.event\"}\n", "unknown_event"],
    ["invalid JSON", "{nope}\n", "invalid_json"],
    ["truncated JSON", "{\"type\":", "truncated_stream"],
  ])("classifies %s as infrastructure failure", (_name, input, code) => {
    expect(() => parseHostChunks(new CodexEventParser(), [input])).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects oversized streams before scoring", () => {
    expect(() => parseHostChunks(
      new CodexEventParser(),
      ["{\"type\":\"thread.started\",\"thread_id\":\"too-large\"}\n"],
      { maxBytes: 8 },
    )).toThrowError(expect.objectContaining({ code: "oversized_stream" }));
  });

  it("terminates a timed-out child instead of hanging", async () => {
    const promise = runHostCommand({
      host: "codex",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 25,
      parser: new CodexEventParser(),
    });
    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<HostTraceError>>({
      code: "process_timeout",
    }));
  });

  it("terminates a host when its tool-call budget is exceeded", async () => {
    const lines = [
      { type: "thread.started", thread_id: "budget-session" },
      { type: "item.started", item: { type: "mcp_tool_call", id: "call-1", server: "artifactpass", tool: "publish_artifact", arguments: {} } },
    ].map((line) => `${JSON.stringify(line)}\n`).join("");
    const promise = runHostCommand({
      host: "codex",
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(lines)}); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 1_000,
      maxToolCalls: 0,
      parser: new CodexEventParser(),
    });
    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<HostTraceError>>({
      code: "budget_exceeded",
    }));
  });

  it("terminates a host when its step budget is exceeded", async () => {
    const lines = [
      { type: "thread.started", thread_id: "budget-session" },
      { type: "item.completed", item: { type: "agent_message", id: "message-1", text: "done" } },
    ].map((line) => `${JSON.stringify(line)}\n`).join("");
    const promise = runHostCommand({
      host: "codex",
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(lines)}); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 1_000,
      maxSteps: 0,
      parser: new CodexEventParser(),
    });
    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<HostTraceError>>({
      code: "budget_exceeded",
    }));
  });

  it("terminates a host when reported cost exceeds its remaining budget", async () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "budget-session" },
      { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.51 },
    ].map((line) => `${JSON.stringify(line)}\n`).join("");
    const promise = runHostCommand({
      host: "claude",
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(lines)}); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 1_000,
      maximumCostUsd: 0.5,
      parser: new ClaudeEventParser(),
    });
    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<HostTraceError>>({
      code: "budget_exceeded",
    }));
  });

  it.runIf(process.platform !== "win32")("force-kills a child that ignores SIGTERM", async () => {
    const promise = runHostCommand({
      host: "codex",
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 25,
      terminationGraceMilliseconds: 25,
      parser: new CodexEventParser(),
    });
    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<HostTraceError>>({
      code: "process_timeout",
    }));
  });

  it("preserves a multibyte JSON event split across stdout chunks", async () => {
    const line = Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: "sessión" })}\n`);
    const split = line.indexOf(Buffer.from("ó")) + 1;
    const script = [
      `const value = Buffer.from(${JSON.stringify(line.toString("base64"))}, 'base64');`,
      `process.stdout.write(value.subarray(0, ${split}));`,
      `setTimeout(() => process.stdout.write(value.subarray(${split})), 10);`,
    ].join("");
    const result = await runHostCommand({
      host: "codex",
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 1_000,
      parser: new CodexEventParser(),
    });
    expect(result.events.find((event) => event.kind === "session")).toMatchObject({ sessionId: "sessión" });
  });

  it("records timing and process exit for a bounded child", async () => {
    const line = `${JSON.stringify({ type: "thread.started", thread_id: "child-session" })}\n`;
    const result = await runHostCommand({
      host: "codex",
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(line)})`],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMilliseconds: 1_000,
      parser: new CodexEventParser(),
    });
    expect(result.events.map((event) => event.kind)).toEqual(["session", "timing", "process_exit"]);
    expect(result.exitCode).toBe(0);
  });

  it("bounds a hung CLI version probe", async () => {
    await expect(versionFor(process.execPath, {
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMilliseconds: 25,
    })).resolves.toBeUndefined();
  });

  it("refuses a failed or nonzero model execution even when another terminal event succeeded", () => {
    const terminal = {
      version: 1 as const,
      host: "codex" as const,
      sequence: 0,
      kind: "terminal" as const,
      status: "succeeded" as const,
    };
    expect(modelExecutionFailure({ events: [terminal], stderr: "", exitCode: 2, signal: null })).toBeTruthy();
    expect(modelExecutionFailure({
      events: [terminal, { ...terminal, sequence: 1, status: "failed" }],
      stderr: "",
      exitCode: 0,
      signal: null,
    })).toBeTruthy();
    expect(modelExecutionFailure({ events: [terminal], stderr: "", exitCode: 0, signal: null })).toBeUndefined();
  });
});
