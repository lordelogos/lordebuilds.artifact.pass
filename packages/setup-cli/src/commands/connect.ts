import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ARTIFACTPASS_CREDENTIAL_SERVICE,
  LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
  OsCredentialStore,
  agentCredentialAccountForProfile,
  assertDeploymentOrigin,
  defaultLocalConfigPath,
  legacyLocalConfigPath,
  fetchWithoutRedirects,
  readLocalBridgeSettings,
  upsertLocalBridgeProfile,
  validateProfileName,
  writeLocalBridgeSettings,
  type CredentialStore,
  type LocalBridgeSettings,
} from "agent-bridge";

import { completeDeviceFlow, type DeviceFlowDependencies } from "../device-flow";
import { detectHosts, installPluginForHosts, type AgentHost } from "../hosts";
import type { ProcessRunner } from "../process";
import { runProcess } from "../process";
import { migrateLegacyLocalState } from "../local-state-migration";

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const revokeToken = async (
  origin: URL,
  token: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<void> => {
  const response = await fetchWithoutRedirects(
    fetchImplementation,
    new URL("/api/connection", origin),
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not revoke Artifact Share connection (${response.status})`);
  }
};

export interface ConnectInput {
  readonly profileName?: string;
  readonly baseUrl: string;
  readonly workspaceRoots: readonly string[];
  readonly openDevelopment?: boolean;
  readonly hosts?: readonly AgentHost[];
  readonly installKnownHostAdapters?: boolean;
  readonly marketplaceSource: string;
  readonly configPath?: string;
}

export interface ConnectDependencies {
  readonly runner?: ProcessRunner;
  readonly credentialStore?: CredentialStore;
  readonly deviceFlow?: typeof completeDeviceFlow;
  readonly deviceFlowDependencies: DeviceFlowDependencies;
  readonly readSettings?: (path: string) => Promise<LocalBridgeSettings>;
  readonly writeSettings?: typeof writeLocalBridgeSettings;
  readonly migrateState?: typeof migrateLegacyLocalState;
}

export const connectHost = async (
  input: ConnectInput,
  dependencies: ConnectDependencies,
): Promise<{
  readonly hosts: readonly AgentHost[];
  readonly profileName: string;
  readonly expiresIn?: number;
  readonly configPath: string;
}> => {
  const openDevelopment = input.openDevelopment === true;
  const profileName = validateProfileName(input.profileName ?? (openDevelopment ? "local" : "production"));
  const origin = assertDeploymentOrigin(new URL(input.baseUrl), { openDevelopment });
  const roots = input.workspaceRoots.map((root) => resolve(root));
  if (roots.length === 0) throw new Error("At least one workspace root is required");
  const fetchImplementation = dependencies.deviceFlowDependencies.fetch ?? globalThis.fetch;
  const health = await fetchWithoutRedirects(
    fetchImplementation,
    new URL("/health", origin),
  );
  const healthBody = await health.clone().json().catch(() => null) as {
    readonly service?: string;
    readonly status?: string;
    readonly pdf_provenance_key_id?: string;
  } | null;
  if (
    !health.ok ||
    healthBody?.service !== "lordebuilds.artifacts.share" ||
    healthBody.status !== "ok"
  ) {
    throw new Error(`Artifact Share health check failed (${health.status})`);
  }
  const configPath = input.configPath ?? defaultLocalConfigPath();
  if (input.configPath === undefined) {
    await (dependencies.migrateState ?? migrateLegacyLocalState)({
      artifactpassConfigPath: configPath,
      legacyConfigPath: legacyLocalConfigPath(),
      artifactpassCredentialStore: (account) => new OsCredentialStore({
        service: ARTIFACTPASS_CREDENTIAL_SERVICE,
        account,
      }),
      legacyCredentialStore: (account) => new OsCredentialStore({
        service: LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
        account,
      }),
    });
  }
  const previousSettings = await (dependencies.readSettings ?? readLocalBridgeSettings)(configPath).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  const previousProfile = previousSettings?.profiles[profileName];
  const store = dependencies.credentialStore ?? new OsCredentialStore({
    service: ARTIFACTPASS_CREDENTIAL_SERVICE,
    account: agentCredentialAccountForProfile(profileName),
  });
  if (openDevelopment && previousProfile !== undefined && previousProfile.open_development !== true) {
    const previousToken = await store.get();
    if (previousToken !== null) {
      throw new Error(
        `Disconnect the existing hosted Artifact Share ${profileName} profile before replacing it with open development`,
      );
    }
  }
  const runner = dependencies.runner ?? runProcess;
  const installKnownHostAdapters = input.installKnownHostAdapters !== false;
  const hosts = installKnownHostAdapters ? (input.hosts ?? await detectHosts(runner)) : [];
  if (installKnownHostAdapters && hosts.length === 0) {
    throw new Error("No supported automatic host installer was detected; use --no-host-install for portable MCP and skills setup");
  }
  if (installKnownHostAdapters) {
    await installPluginForHosts(hosts, input.marketplaceSource, runner);
  }
  if (openDevelopment) {
    await (dependencies.writeSettings ?? writeLocalBridgeSettings)(configPath, upsertLocalBridgeProfile(
      previousSettings,
      profileName,
      {
        base_url: origin.toString(),
        workspace_roots: roots,
        open_development: true,
        ...(previousProfile?.publication_state === "legacy" ? { publication_state: "legacy" } : {}),
        ...(previousProfile?.publication_state_path === undefined
          ? {}
          : { publication_state_path: previousProfile.publication_state_path }),
        credential_namespace: "artifactpass",
      },
    ));
    return { hosts, profileName, configPath };
  }
  const previousToken = await store.get();
  if (previousToken !== null && previousProfile === undefined) {
    throw new Error(`The existing Artifact Share ${profileName} credential has no matching profile; disconnect it first`);
  }
  const token = await (dependencies.deviceFlow ?? completeDeviceFlow)(
    origin.toString(),
    dependencies.deviceFlowDependencies,
  );
  let wroteConfig = false;
  try {
    await (dependencies.writeSettings ?? writeLocalBridgeSettings)(configPath, upsertLocalBridgeProfile(
      previousSettings,
      profileName,
      {
        base_url: origin.toString(),
        workspace_roots: roots,
        ...(previousProfile?.publication_state === "legacy" ? { publication_state: "legacy" } : {}),
        ...(previousProfile?.publication_state_path === undefined
          ? {}
          : { publication_state_path: previousProfile.publication_state_path }),
        credential_namespace: "artifactpass",
        ...(healthBody.pdf_provenance_key_id === undefined
          ? {}
          : { pdf_key_id: healthBody.pdf_provenance_key_id }),
      },
    ));
    wroteConfig = true;
    await store.set(token.accessToken);
    if (
      previousToken !== null &&
      previousProfile !== undefined &&
      previousProfile.open_development !== true
    ) {
      await revokeToken(
        assertDeploymentOrigin(new URL(previousProfile.base_url)),
        previousToken,
        fetchImplementation,
      );
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await revokeToken(origin, token.accessToken, fetchImplementation).catch((cleanupError: unknown) => {
      cleanupErrors.push(cleanupError);
    });
    if (previousToken === null) {
      await store.delete().catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    } else {
      await store.set(previousToken).catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    }
    if (wroteConfig) {
      const restoreConfig = previousSettings === null
        ? rm(configPath, { force: true })
        : (dependencies.writeSettings ?? writeLocalBridgeSettings)(configPath, previousSettings);
      await restoreConfig.catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Artifact Share connection failed and cleanup was incomplete");
    }
    throw error;
  }
  return { hosts, profileName, expiresIn: token.expiresIn, configPath };
};
