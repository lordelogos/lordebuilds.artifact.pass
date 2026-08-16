import { delimiter } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  EnvironmentCredentialStore,
  OsCredentialStore,
  resolveCredential,
  type CredentialStore,
} from "./auth/credential-store";
import { assertSafeDeploymentOrigin } from "./http/safe-fetch";
import {
  createRedactingLogger,
  redactSensitiveText,
  type RedactingLogger,
} from "./logging/redacting-logger";
import { publishArtifact } from "./tools/publish-artifact";
import { readArtifact } from "./tools/read-artifact";

export interface BridgeConfiguration {
  readonly baseUrl: URL;
  readonly workspaceRoots: readonly string[];
  readonly headless: boolean;
  readonly environmentStore: CredentialStore;
  readonly osStore?: CredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: RedactingLogger;
}

const errorResult = (error: unknown) => ({
  isError: true,
  content: [{
    type: "text" as const,
    text: error instanceof Error
      ? redactSensitiveText(error.message)
      : "Artifact Share bridge failed",
  }],
});

export const createBridgeServer = (configuration: BridgeConfiguration): McpServer => {
  const server = new McpServer(
    { name: "lordebuilds.artifacts.share", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  const logger = configuration.logger ?? createRedactingLogger();

  server.registerTool("publish_artifact", {
    title: "Publish Artifact",
    description: "Publish one approved local Markdown, HTML, or PDF file without placing its bytes in model context.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Absolute or workspace-relative local file path"),
      expires_in_seconds: z.number().int().positive().describe("Deployment-allowed expiration preset"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ path, expires_in_seconds: expiresInSeconds }) => {
    try {
      const token = await resolveCredential({
        headless: configuration.headless,
        environmentStore: configuration.environmentStore,
        ...(configuration.osStore === undefined ? {} : { osStore: configuration.osStore }),
      });
      const result = await publishArtifact({ path, expiresInSeconds }, {
        baseUrl: configuration.baseUrl,
        workspaceRoots: configuration.workspaceRoots,
        token,
        ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      logger.error("publish_artifact failed", { error: error instanceof Error ? error.message : error });
      return errorResult(error);
    }
  });

  server.registerTool("read_artifact", {
    title: "Read Artifact",
    description: "Read a configured Artifact Share URL in bounded deterministic chunks with exact-source and PDF fidelity metadata.",
    inputSchema: z.object({
      share_url: z.string().url(),
      cursor: z.string().optional(),
      max_bytes: z.number().int().positive().optional(),
      representation: z.enum(["auto", "source", "derived"]).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ share_url: shareUrl, cursor, max_bytes: maxBytes, representation }) => {
    try {
      const result = await readArtifact({
        shareUrl,
        ...(cursor === undefined ? {} : { cursor }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(representation === undefined ? {} : { representation }),
      }, {
        baseUrl: configuration.baseUrl,
        ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      logger.error("read_artifact failed", { error: error instanceof Error ? error.message : error });
      return errorResult(error);
    }
  });

  return server;
};

export const configurationFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BridgeConfiguration => {
  const baseUrlValue = environment.ARTIFACT_SHARE_BASE_URL;
  if (baseUrlValue === undefined) throw new Error("ARTIFACT_SHARE_BASE_URL is required");
  const rootsValue = environment.ARTIFACT_SHARE_WORKSPACE_ROOTS;
  if (rootsValue === undefined) throw new Error("ARTIFACT_SHARE_WORKSPACE_ROOTS is required");
  const workspaceRoots = rootsValue.split(delimiter).filter((root) => root.length > 0);
  if (workspaceRoots.length === 0) throw new Error("ARTIFACT_SHARE_WORKSPACE_ROOTS must not be empty");
  const environmentStore = new EnvironmentCredentialStore("ARTIFACT_SHARE_TOKEN", environment);
  const headless = environment.ARTIFACT_SHARE_TOKEN !== undefined;
  return {
    baseUrl: assertSafeDeploymentOrigin(new URL(baseUrlValue)),
    workspaceRoots,
    headless,
    environmentStore,
    ...(headless ? {} : { osStore: new OsCredentialStore() }),
  };
};

export const serveBridgeStdio = (
  configuration: BridgeConfiguration = configurationFromEnvironment(),
): StdioServerHandle => serveStdio(() => createBridgeServer(configuration), {
  onerror: (error) => (configuration.logger ?? createRedactingLogger()).error("stdio transport failed", {
    error: error.message,
  }),
});
