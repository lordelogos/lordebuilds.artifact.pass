import { createHash } from "node:crypto";
import { delimiter, isAbsolute, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  ARTIFACTPASS_CREDENTIAL_SERVICE,
  agentCredentialAccountForProfile,
  CompatibleCredentialStore,
  CompatibleEnvironmentCredentialStore,
  LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
  OsCredentialStore,
  resolveAgentCredentialBinding,
  resolveCredential,
  type CredentialStore,
} from "./auth/credential-store";
import {
  createConnectionController,
  type ConnectionController,
} from "./connection/connection-controller";
import {
  bindLocalBridgeWorkspace,
  defaultLocalConfigPath,
  legacyLocalConfigPath,
  publicationStatePathForProfile,
  readCompatibleLocalBridgeSettingsSync,
  setActiveLocalBridgeProfile,
  selectLocalBridgeProfile,
  updateLocalBridgeSettings,
  upsertLocalBridgeProfile,
  validateProfileName,
} from "./config/local-config";
import {
  approvedRootForPath,
  canonicalExistingPath,
  matchLocalWorkspaceProfile,
  proposedWorkspaceRoot,
} from "./config/workspace-access";
import {
  createWorkspaceApprovalController,
  type WorkspaceApprovalRequest,
} from "./connection/workspace-approval-controller";
import type { BrowserOpener } from "./connection/open-browser";
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
  connectionInputSchema,
  connectionOutputSchema,
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
  readonly connectionController?: ConnectionController;
  readonly pdfProvenance?: {
    readonly keyId: string;
    readonly privateKeyPkcs8Base64: string;
  };
  readonly pdfProvenanceKeyId?: string;
  readonly pdfProvenanceStore?: CredentialStore;
}

export interface BridgeConfigurationSource {
  defaultConfiguration(): BridgeConfiguration;
  forWorkspacePath(path: string): BridgeConfiguration;
  resolveWorkspacePath(path: string, workspaceRoot?: string): Promise<BridgeWorkspaceResolution>;
  approveWorkspace?(request: WorkspaceApprovalRequest, origin: string): Promise<void>;
  forShareUrl(url: string): BridgeConfiguration;
  runtimeKey(configuration: BridgeConfiguration): string;
}

export type BridgeWorkspaceResolution =
  | {
      readonly status: "approved";
      readonly configuration: BridgeConfiguration;
      readonly workspaceRoot: string;
    }
  | {
      readonly status: "workspace_required";
      readonly workspaceRoot: string;
      readonly proposedOrigin: string;
      readonly availableOrigins: readonly string[];
      readonly deploymentFixed: boolean;
    };

export interface BridgeServerOptions {
  readonly openWorkspaceApprovalBrowser?: BrowserOpener;
  readonly workspaceApprovalTimeoutMilliseconds?: number;
}

const resolvePdfProvenance = async (
  configuration: BridgeConfiguration,
): Promise<BridgeConfiguration["pdfProvenance"]> => {
  if (configuration.pdfProvenance !== undefined) return configuration.pdfProvenance;
  if (configuration.pdfProvenanceKeyId !== undefined && configuration.pdfProvenanceStore !== undefined) {
    const privateKeyPkcs8Base64 = await configuration.pdfProvenanceStore.get();
    if (privateKeyPkcs8Base64 === null) {
      throw new Error(
        `No PDF signing credential is stored for key ${configuration.pdfProvenanceKeyId}`,
      );
    }
    return { keyId: configuration.pdfProvenanceKeyId, privateKeyPkcs8Base64 };
  }
  if (configuration.osStore !== undefined) {
    const stored = await configuration.osStore.get();
    if (stored !== null) {
      const binding = resolveAgentCredentialBinding(
        stored,
        configuration.baseUrl,
        configuration.requireOriginBoundCredential === true,
      );
      if (binding.deviceSigning !== undefined) {
        return {
          keyId: binding.deviceSigning.keyId,
          privateKeyPkcs8Base64: binding.deviceSigning.privateKeyPkcs8Base64,
        };
      }
    }
  }
  return undefined;
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

const createConfiguredConnectionController = (
  configuration: BridgeConfiguration,
  profileName: string,
): ConnectionController => {
  const base = () => ({
    profile: profileName,
    origin: configuration.baseUrl.origin,
  });
  if (configuration.openDevelopment === true) {
    return {
      status: async () => ({ status: "connected" as const, ...base() }),
      connect: async () => ({ status: "connected" as const, ...base() }),
    };
  }
  if (configuration.headless || configuration.osStore === undefined) {
    return {
      status: async () => {
        try {
          await resolveCredential({
            headless: configuration.headless,
            environmentStore: configuration.environmentStore,
            ...(configuration.osStore === undefined ? {} : { osStore: configuration.osStore }),
            expectedOrigin: configuration.baseUrl,
            requireOriginBinding: configuration.requireOriginBoundCredential === true,
          });
          return { status: "connected" as const, ...base() };
        } catch {
          return { status: "disconnected" as const, ...base() };
        }
      },
      connect: async () => ({
        status: "failed" as const,
        ...base(),
        message: "This headless ArtifactPass connection must be managed by its secret manager.",
      }),
    };
  }
  return createConnectionController({
    origin: configuration.baseUrl,
    profileName,
    credentialStore: configuration.osStore,
    agentName: "ArtifactPass MCP",
    workspaceIdentity: profileName,
    ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
  });
};

interface BridgeRuntime {
  readonly configuration: BridgeConfiguration;
  readonly connectionController: ConnectionController;
  readonly publicationJournal: PublicationJournal;
}

interface BridgeResources {
  readonly connectionController: ConnectionController;
  readonly publicationJournal: PublicationJournal;
}

const maximumCachedRuntimes = 32;

const isConfigurationSource = (
  value: BridgeConfiguration | BridgeConfigurationSource,
): value is BridgeConfigurationSource => "defaultConfiguration" in value;

const fixedConfigurationSource = (
  configuration: BridgeConfiguration,
): BridgeConfigurationSource => ({
  defaultConfiguration: () => configuration,
  forWorkspacePath: () => configuration,
  resolveWorkspacePath: async (path, workspaceRoot) => {
    const proposal = await proposedWorkspaceRoot(path, workspaceRoot);
    const approvedRoot = await approvedRootForPath(proposal.candidate, configuration.workspaceRoots);
    return approvedRoot === undefined
      ? {
          status: "workspace_required",
          workspaceRoot: proposal.root,
          proposedOrigin: configuration.baseUrl.origin,
          availableOrigins: [configuration.baseUrl.origin],
          deploymentFixed: true,
        }
      : { status: "approved", configuration, workspaceRoot: approvedRoot };
  },
  forShareUrl: () => configuration,
  runtimeKey: () => "fixed",
});

export const createBridgeServer = (
  configurationOrSource: BridgeConfiguration | BridgeConfigurationSource,
  options: BridgeServerOptions = {},
): McpServer => {
  const dynamic = isConfigurationSource(configurationOrSource);
  const source = dynamic
    ? configurationOrSource
    : fixedConfigurationSource(configurationOrSource);
  const defaultConfiguration = source.defaultConfiguration();
  const server = new McpServer(
    { name: "lordebuilds.artifacts.share", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  const logger = defaultConfiguration.logger ?? createRedactingLogger();
  const connectionContext = dynamic
    ? ` Default deployment: profile ${defaultConfiguration.profileName ?? "environment"} at ${defaultConfiguration.baseUrl.origin}. ArtifactPass selects a more specific configured deployment from workspace_path or the artifact/link being used.`
    : ` Configured deployment: profile ${defaultConfiguration.profileName ?? "environment"} at ${defaultConfiguration.baseUrl.origin} (${defaultConfiguration.openDevelopment === true ? "open local development" : "authentication required for publishing"}).`;
  const runtimes = new Map<string, BridgeResources>();
  const workspaceApprovalController = source.approveWorkspace === undefined
    ? undefined
    : createWorkspaceApprovalController({
        approve: source.approveWorkspace,
        ...(options.openWorkspaceApprovalBrowser === undefined
          ? {}
          : { openBrowser: options.openWorkspaceApprovalBrowser }),
        ...(options.workspaceApprovalTimeoutMilliseconds === undefined
          ? {}
          : { timeoutMilliseconds: options.workspaceApprovalTimeoutMilliseconds }),
      });
  const closeMcpServer = server.close.bind(server);
  server.close = async () => {
    await workspaceApprovalController?.close();
    await closeMcpServer();
  };
  const runtimeFor = (configuration: BridgeConfiguration): BridgeRuntime => {
    const key = source.runtimeKey(configuration);
    const existing = runtimes.get(key);
    if (existing !== undefined) {
      runtimes.delete(key);
      runtimes.set(key, existing);
      return { configuration, ...existing };
    }
    const profileName = configuration.profileName ?? "environment";
    const resources = {
      publicationJournal: configuration.publicationJournal ?? (
        configuration.publicationStatePath === undefined
          ? new MemoryPublicationJournal()
          : new FilePublicationJournal(configuration.publicationStatePath)
      ),
      connectionController: configuration.connectionController ??
        createConfiguredConnectionController(configuration, profileName),
    };
    runtimes.set(key, resources);
    while (runtimes.size > maximumCachedRuntimes) {
      const oldest = runtimes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      runtimes.delete(oldest);
    }
    return { configuration, ...resources };
  };

  const connectionResult = (
    state: Awaited<ReturnType<ConnectionController["status"]>>,
    workspaceRoot: string,
  ) => ({
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
    structuredContent: {
      ...state,
      authentication_status: state.status,
      workspace_status: "approved" as const,
      ready_to_publish: state.status === "connected",
      workspace_root: workspaceRoot,
      ...(state.status === "connecting" ? { phase: "authentication" as const } : {}),
    },
  });

  const workspaceRequiredResult = (resolution: Extract<BridgeWorkspaceResolution, { status: "workspace_required" }>) => {
    const state = {
      status: "workspace_required" as const,
      authentication_status: "unknown" as const,
      workspace_status: "required" as const,
      ready_to_publish: false,
      proposed_origin: resolution.proposedOrigin,
      workspace_root: resolution.workspaceRoot,
      phase: "workspace_approval" as const,
      next_action: "Call connect_artifactpass to review and approve this project.",
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(state) }],
      structuredContent: state,
    };
  };

  const approvalRequestFor = (
    resolution: Extract<BridgeWorkspaceResolution, { status: "workspace_required" }>,
  ): WorkspaceApprovalRequest => ({
    workspaceRoot: resolution.workspaceRoot,
    proposedOrigin: resolution.proposedOrigin,
    availableOrigins: resolution.availableOrigins,
  });

  const workspaceApprovalResult = (
    state: NonNullable<ReturnType<NonNullable<typeof workspaceApprovalController>["status"]>>,
  ) => ({
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
    structuredContent: state,
  });

  server.registerTool("connection_status", {
    title: "ArtifactPass Connection Status",
    description: "Report whether ArtifactPass publishing is disconnected, connecting, connected, or failed for this workspace." + connectionContext,
    inputSchema: connectionInputSchema,
    outputSchema: connectionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ workspace_path: workspacePath, workspace_root: workspaceRoot }) => {
    try {
      const resolution = await source.resolveWorkspacePath(workspacePath, workspaceRoot);
      if (resolution.status === "workspace_required") {
        const pending = workspaceApprovalController?.status(approvalRequestFor(resolution));
        return pending === undefined
          ? workspaceRequiredResult(resolution)
          : workspaceApprovalResult(pending);
      }
      const runtime = runtimeFor(resolution.configuration);
      return connectionResult(await runtime.connectionController.status(), resolution.workspaceRoot);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("connect_artifactpass", {
    title: "Connect ArtifactPass",
    description: "Start ArtifactPass browser sign-in for this workspace. Use this when connection_status reports disconnected. No terminal command or agent restart is required." + connectionContext,
    inputSchema: connectionInputSchema,
    outputSchema: connectionOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ workspace_path: workspacePath, workspace_root: workspaceRoot }) => {
    try {
      const resolution = await source.resolveWorkspacePath(workspacePath, workspaceRoot);
      if (resolution.status === "workspace_required") {
        if (workspaceApprovalController === undefined || resolution.deploymentFixed) {
          return workspaceRequiredResult(resolution);
        }
        return workspaceApprovalResult(
          await workspaceApprovalController.connect(approvalRequestFor(resolution)),
        );
      }
      const runtime = runtimeFor(resolution.configuration);
      return connectionResult(await runtime.connectionController.connect(), resolution.workspaceRoot);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("publish_artifact", {
    title: "Publish Artifact",
    description: "Publish one approved local Markdown, HTML, or PDF file without placing its bytes in model context. If ArtifactPass is disconnected, call connect_artifactpass, complete browser approval, confirm connection_status is connected, and retry once in the same session." + connectionContext,
    inputSchema: publishArtifactInputSchema,
    outputSchema: publishArtifactOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  }, async ({
    path,
    workspace_root: workspaceRoot,
    canonical_source_path: canonicalSourcePath,
    expires_in_seconds: expiresInSeconds,
  }) => {
    try {
      const resolution = await source.resolveWorkspacePath(path, workspaceRoot);
      if (resolution.status === "workspace_required") {
        const result = {
          error: {
            code: "workspace_not_approved" as const,
            attempted_path: path,
            workspace_root: resolution.workspaceRoot,
            proposed_origin: resolution.proposedOrigin,
            next_action: "Call connect_artifactpass with this path and workspace root to approve access.",
          },
        };
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      const runtime = runtimeFor(resolution.configuration);
      const { configuration, publicationJournal } = runtime;
      const [token, pdfProvenance] = await Promise.all([
        configuration.openDevelopment === true
          ? undefined
          : resolveCredential({
            headless: configuration.headless,
            environmentStore: configuration.environmentStore,
            ...(configuration.osStore === undefined ? {} : { osStore: configuration.osStore }),
            expectedOrigin: configuration.baseUrl,
            requireOriginBinding: configuration.requireOriginBoundCredential === true,
          }),
        canonicalSourcePath === undefined ? undefined : resolvePdfProvenance(configuration),
      ]);
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
      const configuration = source.forShareUrl(shareUrl);
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

const compatibleEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  artifactpassName: string,
  legacyName: string,
): string | undefined => {
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

type CompatibleLocalState = ReturnType<typeof readCompatibleLocalBridgeSettingsSync>;

const readEnvironmentLocalState = (
  environment: Readonly<Record<string, string | undefined>>,
  baseUrlEnvironment: string | undefined,
  rootsEnvironment: string | undefined,
): CompatibleLocalState | undefined => {
  if (baseUrlEnvironment !== undefined && rootsEnvironment !== undefined) return undefined;
  const mayUseUnconfiguredPublicPlugin =
    environment.ARTIFACTPASS_CONFIG_PATH === undefined &&
    environment.ARTIFACT_SHARE_CONFIG_PATH === undefined;
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
};

const configurationFromEnvironmentAndState = (
  environment: Readonly<Record<string, string | undefined>>,
  currentWorkspace: string,
  localState: CompatibleLocalState | undefined,
): BridgeConfiguration => {
  const compatibleValue = (artifactpassName: string, legacyName: string): string | undefined =>
    compatibleEnvironmentValue(environment, artifactpassName, legacyName);
  const baseUrlEnvironment = compatibleValue("ARTIFACTPASS_BASE_URL", "ARTIFACT_SHARE_BASE_URL");
  const rootsEnvironment = compatibleValue("ARTIFACTPASS_WORKSPACE_ROOTS", "ARTIFACT_SHARE_WORKSPACE_ROOTS");
  const profileEnvironment = compatibleValue("ARTIFACTPASS_PROFILE", "ARTIFACT_SHARE_PROFILE");
  const openDevelopmentEnvironment = compatibleValue(
    "ARTIFACTPASS_OPEN_DEVELOPMENT",
    "ARTIFACT_SHARE_OPEN_DEVELOPMENT",
  );
  const localConfigPath = localState?.path ?? (
    environment.ARTIFACTPASS_CONFIG_PATH === undefined &&
    environment.ARTIFACT_SHARE_CONFIG_PATH !== undefined
      ? legacyLocalConfigPath(environment)
      : defaultLocalConfigPath(environment)
  );
  const localConfiguration = localState?.settings;
  const selectedProfile = localConfiguration === undefined
    ? undefined
    : selectLocalBridgeProfile(localConfiguration, profileEnvironment, currentWorkspace);
  const localSettings = selectedProfile?.settings;
  const profileName = selectedProfile?.name ?? validateProfileName(
    profileEnvironment ?? (
      openDevelopmentEnvironment === "1" ? "environment" : "production"
    ),
  );
  const baseUrlValue = baseUrlEnvironment ?? localSettings?.base_url ?? "https://artifactpass.com";
  const rootsValue = rootsEnvironment;
  const workspaceRoots = rootsValue === undefined
    ? [...(localSettings?.workspace_roots ?? [resolve(currentWorkspace)])]
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

export const configurationFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  currentWorkspace: string = process.cwd(),
): BridgeConfiguration => {
  const baseUrlEnvironment = compatibleEnvironmentValue(
    environment,
    "ARTIFACTPASS_BASE_URL",
    "ARTIFACT_SHARE_BASE_URL",
  );
  const rootsEnvironment = compatibleEnvironmentValue(
    environment,
    "ARTIFACTPASS_WORKSPACE_ROOTS",
    "ARTIFACT_SHARE_WORKSPACE_ROOTS",
  );
  return configurationFromEnvironmentAndState(
    environment,
    currentWorkspace,
    readEnvironmentLocalState(environment, baseUrlEnvironment, rootsEnvironment),
  );
};

export const createBridgeConfigurationSource = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  processWorkspace: string = process.cwd(),
): BridgeConfigurationSource => {
  const configurationFor = (
    selectedEnvironment: Readonly<Record<string, string | undefined>>,
    workspace: string,
    localState: CompatibleLocalState | undefined,
  ): BridgeConfiguration => configurationFromEnvironmentAndState(
    selectedEnvironment,
    workspace,
    localState,
  );
  const localState = (): CompatibleLocalState | undefined => readEnvironmentLocalState(
    environment,
    compatibleEnvironmentValue(environment, "ARTIFACTPASS_BASE_URL", "ARTIFACT_SHARE_BASE_URL"),
    compatibleEnvironmentValue(
      environment,
      "ARTIFACTPASS_WORKSPACE_ROOTS",
      "ARTIFACT_SHARE_WORKSPACE_ROOTS",
    ),
  );
  const defaultConfiguration = (): BridgeConfiguration =>
    configurationFor(environment, processWorkspace, localState());
  const explicitDeployment = [
    "ARTIFACTPASS_BASE_URL",
    "ARTIFACT_SHARE_BASE_URL",
    "ARTIFACTPASS_PROFILE",
    "ARTIFACT_SHARE_PROFILE",
  ].some((name) => environment[name] !== undefined);
  const headlessToken = compatibleEnvironmentValue(
    environment,
    "ARTIFACTPASS_TOKEN",
    "ARTIFACT_SHARE_TOKEN",
  );
  if (headlessToken !== undefined && !explicitDeployment) {
    throw new Error(
      "Headless ArtifactPass tokens require an explicit ARTIFACTPASS_BASE_URL or ARTIFACTPASS_PROFILE",
    );
  }

  const configPath = (): string => localState()?.path ?? (
    environment.ARTIFACTPASS_CONFIG_PATH === undefined &&
    environment.ARTIFACT_SHARE_CONFIG_PATH !== undefined
      ? legacyLocalConfigPath(environment)
      : defaultLocalConfigPath(environment)
  );
  const availableOrigins = (state: CompatibleLocalState | undefined): string[] => [
    ...new Set([
      "https://artifactpass.com",
      ...Object.values(state?.settings.profiles ?? {}).map((profile) => {
        try {
          return new URL(profile.base_url).origin;
        } catch {
          return profile.base_url;
        }
      }),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const profileNameForOrigin = (
    settings: CompatibleLocalState["settings"] | null,
    origin: string,
  ): string => {
    const existing = Object.entries(settings?.profiles ?? {})
      .filter(([, profile]) => {
        try {
          return new URL(profile.base_url).origin === origin;
        } catch {
          return false;
        }
      })
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right))[0];
    if (existing !== undefined) return existing;
    if (origin === "https://artifactpass.com") return "production";
    const host = new URL(origin).hostname
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")
      .slice(0, 16) || "deployment";
    const hash = createHash("sha256").update(origin).digest("hex").slice(0, 8);
    return validateProfileName(`org-${host}-${hash}`);
  };

  return {
    defaultConfiguration,
    forWorkspacePath: (path) => {
      if (!isAbsolute(path)) {
        throw new Error("ArtifactPass requires an absolute artifact or workspace path");
      }
      const state = localState();
      return configurationFor(
        environment,
        state === undefined ? processWorkspace : path,
        state,
      );
    },
    resolveWorkspacePath: async (path, workspaceRoot) => {
      const proposal = await proposedWorkspaceRoot(path, workspaceRoot);
      const state = localState();
      const fixedByEnvironment = explicitDeployment || compatibleEnvironmentValue(
        environment,
        "ARTIFACTPASS_WORKSPACE_ROOTS",
        "ARTIFACT_SHARE_WORKSPACE_ROOTS",
      ) !== undefined;
      if (fixedByEnvironment) {
        const configuration = configurationFor(environment, proposal.candidate, state);
        const approvedRoot = await approvedRootForPath(
          proposal.candidate,
          configuration.workspaceRoots,
        );
        return approvedRoot === undefined
          ? {
              status: "workspace_required" as const,
              workspaceRoot: proposal.root,
              proposedOrigin: configuration.baseUrl.origin,
              availableOrigins: [configuration.baseUrl.origin],
              deploymentFixed: true,
            }
          : { status: "approved" as const, configuration, workspaceRoot: approvedRoot };
      }
      if (state !== undefined) {
        const match = await matchLocalWorkspaceProfile(state.settings, proposal.candidate);
        if (match.profileName !== undefined && match.workspaceRoot !== undefined) {
          const configuration = configurationFor({
            ...environment,
            ARTIFACTPASS_PROFILE: match.profileName,
          }, proposal.candidate, state);
          return {
            status: "approved" as const,
            configuration,
            workspaceRoot: match.workspaceRoot,
          };
        }
      }
      return {
        status: "workspace_required" as const,
        workspaceRoot: proposal.root,
        proposedOrigin: "https://artifactpass.com",
        availableOrigins: availableOrigins(state),
        deploymentFixed: false,
      };
    },
    approveWorkspace: async (request, originValue) => {
      if (explicitDeployment || compatibleEnvironmentValue(
        environment,
        "ARTIFACTPASS_WORKSPACE_ROOTS",
        "ARTIFACT_SHARE_WORKSPACE_ROOTS",
      ) !== undefined) {
        throw new Error("This ArtifactPass workspace policy is managed by the agent environment.");
      }
      const workspaceRoot = await canonicalExistingPath(request.workspaceRoot);
      if (workspaceRoot !== request.workspaceRoot) {
        throw new Error("The project folder changed while approval was open. Start approval again.");
      }
      const enteredUrl = new URL(originValue);
      const before = localState()?.settings ?? null;
      const existingProfile = Object.values(before?.profiles ?? {}).find((profile) => {
        try {
          return new URL(profile.base_url).origin === enteredUrl.origin;
        } catch {
          return false;
        }
      });
      const origin = assertDeploymentOrigin(enteredUrl, {
        openDevelopment: existingProfile?.open_development === true,
      }).origin;
      await updateLocalBridgeSettings(configPath(), async (current) => {
        if (current !== null) {
          const currentMatch = await matchLocalWorkspaceProfile(current, workspaceRoot);
          if (currentMatch.profileName !== undefined) {
            const currentProfile = current.profiles[currentMatch.profileName];
            if (currentProfile === undefined) {
              throw new Error("The approved ArtifactPass deployment no longer exists.");
            }
            const currentOrigin = new URL(currentProfile.base_url).origin;
            if (currentOrigin !== origin) {
              throw new Error(
                `This project was approved for ${currentOrigin} while this page was open. Start approval again to change it.`,
              );
            }
            return current;
          }
        }
        const profileName = profileNameForOrigin(current, origin);
        const previousProfile = current?.profiles[profileName];
        if (
          previousProfile !== undefined &&
          new URL(previousProfile.base_url).origin !== origin
        ) {
          throw new Error(`ArtifactPass profile ${profileName} already uses another deployment.`);
        }
        const nextProfile = {
          ...previousProfile,
          base_url: origin,
          workspace_roots: [
            ...new Set([...(previousProfile?.workspace_roots ?? []), workspaceRoot]),
          ],
          ...(previousProfile?.credential_namespace === undefined
            ? { credential_namespace: "artifactpass" as const }
            : {}),
          ...(previousProfile?.credential_binding === undefined
            ? { credential_binding: "origin" as const }
            : {}),
        };
        let next = upsertLocalBridgeProfile(current, profileName, nextProfile);
        if (current !== null && current.active_profile !== profileName) {
          next = setActiveLocalBridgeProfile(next, current.active_profile);
        }
        return bindLocalBridgeWorkspace(next, workspaceRoot, profileName);
      });
    },
    forShareUrl: (url) => {
      const state = localState();
      const fallback = configurationFor(environment, processWorkspace, state);
      const origin = new URL(url).origin;
      if (fallback.baseUrl.origin === origin || explicitDeployment) return fallback;
      if (state === undefined) return fallback;
      const candidates = Object.entries(state.settings.profiles)
        .filter(([, profile]) => {
          try {
            return new URL(profile.base_url).origin === origin;
          } catch {
            return false;
          }
        })
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
      if (candidates.length === 0) return fallback;
      const profileName = candidates.includes(state.settings.active_profile)
        ? state.settings.active_profile
        : candidates[0];
      if (profileName === undefined) return fallback;
      return configurationFor({
        ...environment,
        ARTIFACTPASS_PROFILE: profileName,
      }, processWorkspace, state);
    },
    runtimeKey: (configuration) => JSON.stringify([
      configuration.profileName ?? "environment",
      configuration.baseUrl.origin,
      configuration.openDevelopment === true,
      configuration.headless,
      configuration.requireOriginBoundCredential === true,
      configuration.publicationStatePath ?? "memory",
    ]),
  };
};

export const serveBridgeStdio = (
  configurationOrSource: BridgeConfiguration | BridgeConfigurationSource = createBridgeConfigurationSource(),
): StdioServerHandle => serveStdio(() => createBridgeServer(configurationOrSource), {
  onerror: (error) => {
    const configuredLogger = isConfigurationSource(configurationOrSource)
      ? configurationOrSource.defaultConfiguration().logger
      : configurationOrSource.logger;
    (configuredLogger ?? createRedactingLogger()).error("stdio transport failed", {
      error: error.message,
    });
  },
});
