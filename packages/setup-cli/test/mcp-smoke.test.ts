import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeLocalBridgeSettings } from "agent-bridge";
import { expect, it } from "vitest";

import { smokeArtifactpassMcp } from "../src/mcp-smoke";
import { installPortableIntegration } from "../src/portable-integration";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

it("negotiates and invokes the installed portable ArtifactPass MCP", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "artifactpass-install-smoke-"));
  try {
    const configPath = resolve(root, "config.json");
    await writeLocalBridgeSettings(configPath, {
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          workspace_roots: [root],
          open_development: true,
          credential_namespace: "artifactpass",
        },
      },
    });
    const portable = await installPortableIntegration({
      sourceRoot: resolve(repositoryRoot, "plugins/artifactpass"),
      destinationDirectory: resolve(root, "portable"),
    });

    await expect(smokeArtifactpassMcp({
      mcpConfigPath: portable.mcpConfig,
      localConfigPath: configPath,
    })).resolves.toEqual({
      negotiated: true,
      tools: ["publish_artifact", "read_artifact"],
      representativeInvocation: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
