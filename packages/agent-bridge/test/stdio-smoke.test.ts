import { dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

describe("built stdio bridge", () => {
  it("negotiates MCP v2, exposes plugin-native connection tools, and invokes a safety boundary", async () => {
    const bridgePath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
    const agentToken = `as_${"t".repeat(43)}`;
    const shareToken = "s".repeat(32);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bridgePath],
      cwd: dirname(bridgePath),
      env: {
        ARTIFACT_SHARE_BASE_URL: "https://artifacts.example.test",
        ARTIFACT_SHARE_TOKEN: agentToken,
        ARTIFACT_SHARE_WORKSPACE_ROOTS: [process.cwd()].join(delimiter),
      },
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const client = new Client({ name: "agent-bridge-smoke", version: "0.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "connect_artifactpass",
        "connection_status",
        "publish_artifact",
        "read_artifact",
      ]);
      expect(listed.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "publish_artifact",
          outputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({
          name: "read_artifact",
          outputSchema: expect.objectContaining({ type: "object" }),
        }),
      ]));
      expect(listed.tools.find((tool) => tool.name === "publish_artifact")?.annotations)
        .not.toHaveProperty("idempotentHint");
      for (const tool of listed.tools) {
        expect(tool.description).toContain("profile production");
        expect(tool.description).toContain("https://artifacts.example.test");
      }

      const connection = await client.callTool({
        name: "connection_status",
        arguments: {},
      });
      expect(connection.isError).not.toBe(true);
      expect(connection.structuredContent).toMatchObject({
        status: "connected",
        profile: "production",
        origin: "https://artifacts.example.test",
      });

      const result = await client.callTool({
        name: "read_artifact",
        arguments: {
          share_url: `https://foreign.example/a/${shareToken}`,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
      ]));
    } finally {
      await client.close();
    }

    const controlledLogs = stderr.join("");
    expect(controlledLogs).not.toContain(agentToken);
    expect(controlledLogs).not.toContain(shareToken);
  });
});
