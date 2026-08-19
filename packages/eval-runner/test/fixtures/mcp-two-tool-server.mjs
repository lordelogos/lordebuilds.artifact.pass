import { appendFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const evidencePath = process.env.ARTIFACTPASS_CONFIG_PATH;
if (evidencePath === undefined) throw new Error("ARTIFACTPASS_CONFIG_PATH is required");

const server = new McpServer(
  { name: "artifactpass-allowlist-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

for (const name of ["publish_artifact", "read_artifact"]) {
  server.registerTool(name, { description: `Fixture ${name} tool` }, async () => {
    await appendFile(evidencePath, `${name}\n`);
    return { content: [{ type: "text", text: name }] };
  });
}

serveStdio(() => server);
