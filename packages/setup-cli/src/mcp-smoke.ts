import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { redactSensitiveText } from "agent-bridge";

export interface McpSmokeResult {
  readonly negotiated: true;
  readonly tools: readonly ["publish_artifact", "read_artifact"];
  readonly representativeInvocation: true;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const smokeArtifactpassMcp = async (options: {
  readonly mcpConfigPath: string;
  readonly localConfigPath: string;
  readonly timeoutMilliseconds?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<McpSmokeResult> => {
  const configuration = JSON.parse(await readFile(options.mcpConfigPath, "utf8")) as unknown;
  if (!isRecord(configuration) || !isRecord(configuration.mcpServers)) {
    throw new Error("ArtifactPass portable MCP config is invalid");
  }
  const server = configuration.mcpServers.artifactpass;
  if (
    !isRecord(server) ||
    typeof server.command !== "string" ||
    !Array.isArray(server.args) ||
    !server.args.every((argument) => typeof argument === "string")
  ) {
    throw new Error("ArtifactPass portable MCP server is invalid");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const environment = Object.fromEntries(Object.entries(sourceEnvironment)
    .filter(([name, value]) =>
      value !== undefined &&
      !name.startsWith("ARTIFACTPASS_") &&
      !name.startsWith("ARTIFACT_SHARE_")
    )) as Record<string, string>;
  environment.ARTIFACTPASS_CONFIG_PATH = options.localConfigPath;
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args as string[],
    cwd: dirname(options.mcpConfigPath),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "artifactpass-install-smoke", version: "1" });
  const timeout = options.timeoutMilliseconds ?? 5_000;
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    await client.connect(transport, { timeout });
    const listed = await client.listTools({}, { timeout });
    const tools = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(["publish_artifact", "read_artifact"])) {
      throw new Error("ArtifactPass MCP did not negotiate exactly two expected tools");
    }
    const invocation = await client.callTool({
      name: "read_artifact",
      arguments: { share_url: `https://invalid.example/a/${"s".repeat(43)}` },
    }, { timeout });
    if (invocation.isError !== true) {
      throw new Error("ArtifactPass MCP representative safety invocation did not run");
    }
    return {
      negotiated: true,
      tools: ["publish_artifact", "read_artifact"],
      representativeInvocation: true,
    };
  } catch (error) {
    const detail = redactSensitiveText(stderr.join("").trim());
    throw new Error(
      detail.length === 0
        ? "ArtifactPass MCP smoke verification failed"
        : `ArtifactPass MCP smoke verification failed: ${detail}`,
      { cause: error },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
};
