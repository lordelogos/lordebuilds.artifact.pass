import { appendFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const evidencePath = process.env.ARTIFACTPASS_EVAL_EVIDENCE_PATH;
if (evidencePath === undefined) throw new Error("ARTIFACTPASS_EVAL_EVIDENCE_PATH is required");

const server = new McpServer(
  { name: "artifactpass-eval-probe", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.registerTool("echo", {
  title: "ArtifactPass Eval Echo",
  description: "Return a harmless probe nonce so an ArtifactPass eval can correlate host and service evidence.",
  inputSchema: z.object({ nonce: z.literal("artifactpass-trace-probe") }).strict(),
  outputSchema: z.object({ echoed: z.literal("artifactpass-trace-probe") }).strict(),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ nonce }) => {
  await appendFile(evidencePath, `${JSON.stringify({ tool: "echo", nonce })}\n`, { encoding: "utf8", mode: 0o600 });
  const result = { echoed: nonce } as const;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
});

serveStdio(() => server, {
  onerror: (error) => {
    process.stderr.write(`ArtifactPass eval probe transport failed: ${error.message}\n`);
    process.exitCode = 1;
  },
});
