import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { INVALID_PARAMS, McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const parseArguments = (): {
  readonly allowedTools: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
} => {
  const [flag, encodedAllowedTools, separator, command, ...args] = process.argv.slice(2);
  if (flag !== "--allowed-tools" || encodedAllowedTools === undefined || separator !== "--" || command === undefined) {
    throw new Error("ArtifactPass eval MCP launcher requires --allowed-tools <json> -- <command>");
  }
  const parsed = JSON.parse(encodedAllowedTools) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((tool) => typeof tool === "string" && tool.length > 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error("ArtifactPass eval MCP launcher requires a unique JSON array of allowed tool names");
  }
  return { allowedTools: parsed, command, args };
};

const environment: Record<string, string> = {};
for (const key of [
  "PATH",
  "HOME",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "ARTIFACTPASS_CONFIG_PATH",
  "ARTIFACTPASS_OPEN_DEVELOPMENT",
  "ARTIFACTPASS_WORKSPACE_ROOTS",
]) {
  const value = process.env[key];
  if (value !== undefined) environment[key] = value;
}

const main = async (): Promise<void> => {
  const { allowedTools, command, args } = parseArguments();
  const upstreamTransport = new StdioClientTransport({
    command,
    args: [...args],
    env: environment,
    stderr: "inherit",
  });
  const upstream = new Client({ name: "artifactpass-eval-allowlist", version: "1.0.0" });
  await upstream.connect(upstreamTransport);

  const listed = await upstream.listTools();
  const toolsByName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const missingTools = allowedTools.filter((name) => !toolsByName.has(name));
  if (missingTools.length > 0) {
    await upstream.close();
    throw new Error(`ArtifactPass eval MCP allowlist names unavailable tools: ${missingTools.join(", ")}`);
  }
  const selectedTools = allowedTools.map((name) => toolsByName.get(name)!);
  const upstreamIdentity = upstream.getServerVersion();
  const proxy = new McpServer(
    {
      name: upstreamIdentity?.name ?? "artifactpass-eval-allowlist",
      version: upstreamIdentity?.version ?? "1.0.0",
    },
    { capabilities: { tools: {} } },
  );

  proxy.server.setRequestHandler("tools/list", async () => ({ tools: selectedTools }));
  proxy.server.setRequestHandler("tools/call", async (request) => {
    const selectedTool = toolsByName.get(request.params.name);
    if (!allowedTools.includes(request.params.name) || selectedTool === undefined) {
      throw new ProtocolError(INVALID_PARAMS, `ArtifactPass eval MCP tool is not allowed: ${request.params.name}`);
    }
    const result = await upstream.callTool(request.params);
    return proxy.server.projectCallToolResult(result, selectedTool.outputSchema);
  });

  const downstream = serveStdio(() => proxy, {
    onerror: (error) => {
      process.stderr.write(`ArtifactPass eval MCP proxy failed: ${error.message}\n`);
      process.exitCode = 1;
    },
  });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([downstream.close(), upstream.close()]);
  };
  process.stdin.once("end", () => void close());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().finally(() => process.kill(process.pid, signal));
    });
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`ArtifactPass eval MCP launch failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
