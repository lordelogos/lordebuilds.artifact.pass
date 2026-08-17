import { delimiter, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  agentCredentialAccountForProfile,
  EnvironmentCredentialStore,
  OsCredentialStore,
  resolveCredential,
  type CredentialStore,
} from "./auth/credential-store";
import {
  defaultLocalConfigPath,
  publicationStatePathForProfile,
  readLocalBridgeSettingsSync,
  selectLocalBridgeProfile,
  validateProfileName,
} from "./config/local-config";
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
  readonly profileName?: string;
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
  readonly pdfProvenance?: {
    readonly keyId: string;
    readonly privateKeyPkcs8Base64: string;
  };
  readonly pdfProvenanceKeyId?: string;
  readonly pdfProvenanceStore?: CredentialStore;
}

const resolvePdfProvenance = async (
  configuration: BridgeConfiguration,
): Promise<BridgeConfiguration["pdfProvenance"]> => {
  if (configuration.pdfProvenance !== undefined) return configuration.pdfProvenance;
  if (configuration.pdfProvenanceKeyId === undefined || configuration.pdfProvenanceStore === undefined) {
    return undefined;
  }
  const privateKeyPkcs8Base64 = await configuration.pdfProvenanceStore.get();
  if (privateKeyPkcs8Base64 === null) {
    throw new Error(
      `No PDF signing credential is stored for key ${configuration.pdfProvenanceKeyId}`,
    );
  }
  return { keyId: configuration.pdfProvenanceKeyId, privateKeyPkcs8Base64 };
};

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
  const profileName = configuration.profileName ?? "environment";
  const connectionContext = ` Active connection: profile ${profileName} at ${configuration.baseUrl.origin} (${configuration.openDevelopment === true ? "open local development" : "authenticated deployment"}).`;
  const publicationJournal = configuration.publicationJournal ?? (
    configuration.publicationStatePath === undefined
      ? new MemoryPublicationJournal()
      : new FilePublicationJournal(configuration.publicationStatePath)
  );

  server.registerTool("publish_artifact", {
    title: "Publish Artifact",
    description: "Publish one approved local Markdown, HTML, or PDF file without placing its bytes in model context." + connectionContext,
    inputSchema: publishArtifactInputSchema,
    outputSchema: publishArtifactOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  }, async ({ path, canonical_source_path: canonicalSourcePath, expires_in_seconds: expiresInSeconds }) => {
    try {
      const token = configuration.openDevelopment === true
        ? undefined
        : await resolveCredential({
          headless: configuration.headless,
          environmentStore: configuration.environmentStore,
          ...(configuration.osStore === undefined ? {} : { osStore: configuration.osStore }),
        });
      const pdfProvenance = canonicalSourcePath === undefined
        ? undefined
        : await resolvePdfProvenance(configuration);
      const result = await publishArtifact({
        path,
        expiresInSeconds,
        ...(canonicalSourcePath === undefined ? {} : { canonicalSourcePath }),
      }, {
        baseUrl: configuration.baseUrl,
        workspaceRoots: configuration.workspaceRoots,
        ...(token === undefined ? {} : { token }),
        openDevelopment: configuration.openDevelopment === true,
        journal: publicationJournal,
        ...(pdfProvenance === undefined
          ? {}
          : { pdfProvenance }),
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
    description: "Read a configured Artifact Share URL in bounded deterministic chunks with exact-source and PDF fidelity metadata." + connectionContext,
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
  const localConfiguration = environment.ARTIFACT_SHARE_BASE_URL === undefined ||
      environment.ARTIFACT_SHARE_WORKSPACE_ROOTS === undefined
    ? readLocalBridgeSettingsSync(localConfigPath)
    : undefined;
  const selectedProfile = localConfiguration === undefined
    ? undefined
    : selectLocalBridgeProfile(localConfiguration, environment.ARTIFACT_SHARE_PROFILE);
  const localSettings = selectedProfile?.settings;
  const profileName = selectedProfile?.name ?? validateProfileName(
    environment.ARTIFACT_SHARE_PROFILE ?? (
      environment.ARTIFACT_SHARE_OPEN_DEVELOPMENT === "1" ? "environment" : "production"
    ),
  );
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
    ? localConfiguration === undefined || localSettings?.publication_state === "legacy"
      ? `${localConfigPath}.publication-state`
      : publicationStatePathForProfile(localConfigPath, profileName)
    : resolve(publicationStatePathValue);
  const pdfProvenanceKeyId = environment.ARTIFACT_SHARE_PDF_KEY_ID;
  const pdfProvenancePrivateKey = environment.ARTIFACT_SHARE_PDF_PRIVATE_KEY;
  if ((pdfProvenanceKeyId === undefined) !== (pdfProvenancePrivateKey === undefined)) {
    throw new Error("ARTIFACT_SHARE_PDF_KEY_ID and ARTIFACT_SHARE_PDF_PRIVATE_KEY must be configured together");
  }
  return {
    profileName,
    baseUrl: assertDeploymentOrigin(new URL(baseUrlValue), { openDevelopment }),
    workspaceRoots,
    openDevelopment,
    headless,
    environmentStore,
    publicationStatePath,
    ...(pdfProvenanceKeyId === undefined || pdfProvenancePrivateKey === undefined
      ? localSettings?.pdf_key_id === undefined
        ? {}
        : {
            pdfProvenanceKeyId: localSettings.pdf_key_id,
            pdfProvenanceStore: new OsCredentialStore({
              account: `pdf-signing-key:${localSettings.pdf_key_id}`,
            }),
          }
      : {
          pdfProvenance: {
            keyId: pdfProvenanceKeyId,
            privateKeyPkcs8Base64: pdfProvenancePrivateKey,
          },
        }),
    ...(headless ? {} : {
      osStore: new OsCredentialStore({ account: agentCredentialAccountForProfile(profileName) }),
    }),
  };
};

export const serveBridgeStdio = (
  configuration: BridgeConfiguration = configurationFromEnvironment(),
): StdioServerHandle => serveStdio(() => createBridgeServer(configuration), {
  onerror: (error) => (configuration.logger ?? createRedactingLogger()).error("stdio transport failed", {
    error: error.message,
  }),
});
