import { delimiter, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  EnvironmentCredentialStore,
  OsCredentialStore,
  resolveCredential,
  type CredentialStore,
} from "./auth/credential-store";
import { defaultLocalConfigPath, readLocalBridgeSettingsSync } from "./config/local-config";
import { assertDeploymentOrigin } from "./http/safe-fetch";
import {
  createRedactingLogger,
  redactSensitiveText,
  type RedactingLogger,
} from "./logging/redacting-logger";
import { publishArtifact } from "./tools/publish-artifact";
import { readArtifact } from "./tools/read-artifact";
import {
  FilePublicationJournal,
  MemoryPublicationJournal,
  type PublicationJournal,
} from "./state/publication-journal";
import {
  publishArtifactInputSchema,
  publishArtifactOutputSchema,
  readArtifactInputSchema,
  readArtifactOutputSchema,
} from "./tool-contract";

export interface BridgeConfiguration {
  readonly baseUrl: URL;
  readonly workspaceRoots: readonly string[];
  readonly openDevelopment?: boolean;
  readonly headless: boolean;
  readonly environmentStore: CredentialStore;
  readonly osStore?: CredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly logger?: RedactingLogger;
  readonly publicationJournal?: PublicationJournal;
  readonly publicationStatePath?: string;
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
  const publicationJournal = configuration.publicationJournal ?? (
    configuration.publicationStatePath === undefined
      ? new MemoryPublicationJournal()
      : new FilePublicationJournal(configuration.publicationStatePath)
  );

  server.registerTool("publish_artifact", {
    title: "Publish Artifact",
    description: "Publish one approved local Markdown, HTML, or PDF file without placing its bytes in model context.",
    inputSchema: publishArtifactInputSchema,
    outputSchema: publishArtifactOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ path, expires_in_seconds: expiresInSeconds }) => {
    try {
      const token = configuration.openDevelopment === true
        ? undefined
        : await resolveCredential({
          headless: configuration.headless,
          environmentStore: configuration.environmentStore,
          ...(configuration.osStore === undefined ? {} : { osStore: configuration.osStore }),
        });
      const result = await publishArtifact({ path, expiresInSeconds }, {
        baseUrl: configuration.baseUrl,
        workspaceRoots: configuration.workspaceRoots,
        ...(token === undefined ? {} : { token }),
        openDevelopment: configuration.openDevelopment === true,
        journal: publicationJournal,
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
    inputSchema: readArtifactInputSchema,
    outputSchema: readArtifactOutputSchema,
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
        openDevelopment: configuration.openDevelopment === true,
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
  const localConfigPath = defaultLocalConfigPath(environment);
  const localSettings = environment.ARTIFACT_SHARE_BASE_URL === undefined ||
      environment.ARTIFACT_SHARE_WORKSPACE_ROOTS === undefined
    ? readLocalBridgeSettingsSync(localConfigPath)
    : undefined;
  const baseUrlValue = environment.ARTIFACT_SHARE_BASE_URL ?? localSettings?.base_url;
  if (baseUrlValue === undefined) throw new Error("ARTIFACT_SHARE_BASE_URL is required");
  const rootsValue = environment.ARTIFACT_SHARE_WORKSPACE_ROOTS;
  const workspaceRoots = rootsValue === undefined
    ? [...(localSettings?.workspace_roots ?? [])]
    : rootsValue.split(delimiter).filter((root) => root.length > 0);
  if (workspaceRoots.length === 0) throw new Error("ARTIFACT_SHARE_WORKSPACE_ROOTS must not be empty");
  const environmentStore = new EnvironmentCredentialStore("ARTIFACT_SHARE_TOKEN", environment);
  const openDevelopmentValue = environment.ARTIFACT_SHARE_OPEN_DEVELOPMENT;
  if (openDevelopmentValue !== undefined && openDevelopmentValue !== "1") {
    throw new Error("ARTIFACT_SHARE_OPEN_DEVELOPMENT must be 1 when enabled");
  }
  const openDevelopment = openDevelopmentValue === "1" || (
    openDevelopmentValue === undefined &&
    environment.ARTIFACT_SHARE_BASE_URL === undefined &&
    localSettings?.open_development === true
  );
  const headless = environment.ARTIFACT_SHARE_TOKEN !== undefined;
  const publicationStatePathValue = environment.ARTIFACT_SHARE_STATE_PATH;
  const publicationStatePath = publicationStatePathValue === undefined
    ? `${localConfigPath}.publication-state`
    : resolve(publicationStatePathValue);
  return {
    baseUrl: assertDeploymentOrigin(new URL(baseUrlValue), { openDevelopment }),
    workspaceRoots,
    openDevelopment,
    headless,
    environmentStore,
    publicationStatePath,
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
