import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  NORMALIZED_HOST_EVENT_VERSION,
  type NormalizedHostEvent,
} from "../contracts";

interface GenericMcpConfiguration {
  readonly mcpServers?: Readonly<Record<string, {
    readonly command?: unknown;
    readonly args?: unknown;
  }>>;
}

export interface GenericMcpHost {
  readonly events: readonly NormalizedHostEvent[];
  readonly listTools: () => Promise<readonly string[]>;
  readonly callTool: (name: string, arguments_: Readonly<Record<string, unknown>>) => Promise<{
    readonly isError: boolean;
    readonly value: unknown;
  }>;
  readonly close: () => Promise<void>;
}

export const connectGenericMcpHost = async (options: {
  readonly mcpConfigPath: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<GenericMcpHost> => {
  const configuration = JSON.parse(await readFile(options.mcpConfigPath, "utf8")) as GenericMcpConfiguration;
  const server = configuration.mcpServers?.artifactpass;
  if (
    typeof server?.command !== "string" ||
    !Array.isArray(server.args) ||
    !server.args.every((argument) => typeof argument === "string")
  ) {
    throw new Error("The installed ArtifactPass MCP configuration is invalid");
  }
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args as string[],
    cwd: dirname(options.mcpConfigPath),
    env: { ...options.environment },
    stderr: "pipe",
  });
  const client = new Client({ name: "artifactpass-eval-generic", version: "1" });
  const events: NormalizedHostEvent[] = [{
    version: NORMALIZED_HOST_EVENT_VERSION,
    host: "generic",
    sequence: 0,
    kind: "session",
    sessionId: randomUUID(),
  }];
  let sequence = 1;
  await client.connect(transport, { timeout: 10_000 });
  return {
    get events() {
      return events;
    },
    listTools: async () => {
      const result = await client.listTools({}, { timeout: 10_000 });
      return result.tools.map((tool) => tool.name).sort();
    },
    callTool: async (name, arguments_) => {
      const callId = randomUUID();
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: "generic",
        sequence: sequence++,
        kind: "tool_call",
        callId,
        hostToolName: name,
        serverName: "artifactpass",
        toolName: name,
        arguments: arguments_,
      });
      const result = await client.callTool({ name, arguments: arguments_ }, { timeout: 20_000 });
      const value = result.structuredContent ?? result.content;
      events.push({
        version: NORMALIZED_HOST_EVENT_VERSION,
        host: "generic",
        sequence: sequence++,
        kind: "tool_result",
        callId,
        result: value,
        isError: result.isError === true,
      });
      return { isError: result.isError === true, value };
    },
    close: async () => client.close(),
  };
};
