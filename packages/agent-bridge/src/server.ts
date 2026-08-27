import { delimiter, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  ARTIFACTPASS_CREDENTIAL_SERVICE,
  agentCredentialAccountForProfile,
  CompatibleCredentialStore,
  CompatibleEnvironmentCredentialStore,
  LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
  OsCredentialStore,
  resolveCredential,
  type CredentialStore,
} from "./auth/credential-store";
import {
  defaultLocalConfigPath,
  legacyLocalConfigPath,
  publicationStatePathForProfile,
  readCompatibleLocalBridgeSettingsSync,
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
  readonly requireOriginBoundCredential?: boolean;
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
      : "ArtifactPass bridge failed",
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
          expectedOrigin: configuration.baseUrl,
          requireOriginBinding: configuration.requireOriginBoundCredential === true,
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
    description: "Read a configured ArtifactPass URL in bounded deterministic chunks with exact-source and PDF fidelity metadata." + connectionContext,
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
  const compatibleValue = (artifactpassName: string, legacyName: string): string | undefined => {
    const artifactpassValue = environment[artifactpassName];
    const legacyValue = environment[legacyName];
    if (
      artifactpassValue !== undefined && legacyValue !== undefined &&
      artifactpassValue !== legacyValue
    ) {
      throw new Error(`${artifactpassName} conflicts with legacy ${legacyName}`);
    }
    return artifactpassValue ?? legacyValue;
  };
  const baseUrlEnvironment = compatibleValue("ARTIFACTPASS_BASE_URL", "ARTIFACT_SHARE_BASE_URL");
  const rootsEnvironment = compatibleValue("ARTIFACTPASS_WORKSPACE_ROOTS", "ARTIFACT_SHARE_WORKSPACE_ROOTS");
  const profileEnvironment = compatibleValue("ARTIFACTPASS_PROFILE", "ARTIFACT_SHARE_PROFILE");
  const openDevelopmentEnvironment = compatibleValue(
    "ARTIFACTPASS_OPEN_DEVELOPMENT",
    "ARTIFACT_SHARE_OPEN_DEVELOPMENT",
  );
  const mayUseUnconfiguredPublicPlugin =
    environment.ARTIFACTPASS_CONFIG_PATH === undefined &&
    environment.ARTIFACT_SHARE_CONFIG_PATH === undefined;
  const localState = baseUrlEnvironment === undefined || rootsEnvironment === undefined
    ? (() => {
        try {
          return readCompatibleLocalBridgeSettingsSync(environment);
        } catch (error) {
          if (
            mayUseUnconfiguredPublicPlugin &&
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return undefined;
          }
          throw error;
        }
      })()
    : undefined;
  const localConfigPath = localState?.path ?? (
    environment.ARTIFACTPASS_CONFIG_PATH === undefined &&
    environment.ARTIFACT_SHARE_CONFIG_PATH !== undefined
      ? legacyLocalConfigPath(environment)
      : defaultLocalConfigPath(environment)
  );
  const localConfiguration = localState?.settings;
  const selectedProfile = localConfiguration === undefined
    ? undefined
    : selectLocalBridgeProfile(localConfiguration, profileEnvironment);
  const localSettings = selectedProfile?.settings;
  const profileName = selectedProfile?.name ?? validateProfileName(
    profileEnvironment ?? (
      openDevelopmentEnvironment === "1" ? "environment" : "production"
    ),
  );
  const baseUrlValue = baseUrlEnvironment ?? localSettings?.base_url ?? "https://artifactpass.com";
  const rootsValue = rootsEnvironment;
  const workspaceRoots = rootsValue === undefined
    ? [...(localSettings?.workspace_roots ?? [resolve(process.cwd())])]
    : rootsValue.split(delimiter).filter((root) => root.length > 0);
  if (workspaceRoots.length === 0) throw new Error("ARTIFACTPASS_WORKSPACE_ROOTS must not be empty");
  const environmentStore = new CompatibleEnvironmentCredentialStore(
    "ARTIFACTPASS_TOKEN",
    "ARTIFACT_SHARE_TOKEN",
    environment,
  );
  const openDevelopmentValue = openDevelopmentEnvironment;
  if (openDevelopmentValue !== undefined && openDevelopmentValue !== "1") {
    throw new Error("ARTIFACTPASS_OPEN_DEVELOPMENT must be 1 when enabled");
  }
  const openDevelopment = openDevelopmentValue === "1" || (
    openDevelopmentValue === undefined &&
    baseUrlEnvironment === undefined &&
    localSettings?.open_development === true
  );
  const tokenEnvironment = compatibleValue("ARTIFACTPASS_TOKEN", "ARTIFACT_SHARE_TOKEN");
  const headless = tokenEnvironment !== undefined;
  const publicationStatePathValue = compatibleValue(
    "ARTIFACTPASS_STATE_PATH",
    "ARTIFACT_SHARE_STATE_PATH",
  );
  const publicationStatePath = publicationStatePathValue === undefined
    ? localSettings?.publication_state_path ?? (
      localConfiguration === undefined || localSettings?.publication_state === "legacy"
      ? `${localConfigPath}.publication-state`
      : publicationStatePathForProfile(localConfigPath, profileName)
    )
    : resolve(publicationStatePathValue);
  const pdfProvenanceKeyId = compatibleValue("ARTIFACTPASS_PDF_KEY_ID", "ARTIFACT_SHARE_PDF_KEY_ID");
  const pdfProvenancePrivateKey = compatibleValue(
    "ARTIFACTPASS_PDF_PRIVATE_KEY",
    "ARTIFACT_SHARE_PDF_PRIVATE_KEY",
  );
  if ((pdfProvenanceKeyId === undefined) !== (pdfProvenancePrivateKey === undefined)) {
    throw new Error("ARTIFACTPASS_PDF_KEY_ID and ARTIFACTPASS_PDF_PRIVATE_KEY must be configured together");
  }
  return {
    profileName,
    baseUrl: assertDeploymentOrigin(new URL(baseUrlValue), { openDevelopment }),
    workspaceRoots,
    openDevelopment,
    headless,
    environmentStore,
    publicationStatePath,
    ...(localSettings?.credential_binding === "origin"
      ? { requireOriginBoundCredential: true }
      : {}),
    ...(pdfProvenanceKeyId === undefined || pdfProvenancePrivateKey === undefined
      ? localSettings?.pdf_key_id === undefined
        ? {}
        : {
            pdfProvenanceKeyId: localSettings.pdf_key_id,
            pdfProvenanceStore: new CompatibleCredentialStore({
              artifactpassStore: new OsCredentialStore({
                service: ARTIFACTPASS_CREDENTIAL_SERVICE,
                account: `pdf-signing-key:${localSettings.pdf_key_id}`,
              }),
              legacyStore: new OsCredentialStore({
                service: LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
                account: `pdf-signing-key:${localSettings.pdf_key_id}`,
              }),
              migrationCommitted: localSettings.credential_namespace === "artifactpass",
            }),
          }
      : {
          pdfProvenance: {
            keyId: pdfProvenanceKeyId,
            privateKeyPkcs8Base64: pdfProvenancePrivateKey,
          },
        }),
    ...(headless ? {} : {
      osStore: new CompatibleCredentialStore({
        artifactpassStore: new OsCredentialStore({
          service: ARTIFACTPASS_CREDENTIAL_SERVICE,
          account: agentCredentialAccountForProfile(profileName),
        }),
        legacyStore: new OsCredentialStore({
          service: LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
          account: agentCredentialAccountForProfile(profileName),
        }),
        migrationCommitted: localSettings?.credential_namespace === "artifactpass",
      }),
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
