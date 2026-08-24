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
import {
  installPortableIntegration,
  type PortableIntegration,
} from "../portable-integration";

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
    throw new Error(`Could not revoke ArtifactPass connection (${response.status})`);
  }
};

const inspectToken = async (
  origin: URL,
  token: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<{ readonly expiresAt: number } | null> => {
  const response = await fetchWithoutRedirects(
    fetchImplementation,
    new URL("/api/connection", origin),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not validate the existing ArtifactPass connection (${response.status})`);
  }
  const body = await response.json() as {
    readonly status?: string;
    readonly scope?: string;
    readonly expires_at?: number;
  };
  if (
    body.status !== "active" ||
    body.scope !== "artifact:create" ||
    typeof body.expires_at !== "number"
  ) {
    throw new Error("ArtifactPass returned an invalid connection status");
  }
  return { expiresAt: body.expires_at };
};

export interface ConnectInput {
  readonly profileName?: string;
  readonly baseUrl: string;
  readonly workspaceRoots: readonly string[];
  readonly openDevelopment?: boolean;
  readonly hosts?: readonly AgentHost[];
  readonly installKnownHostAdapters?: boolean;
  readonly marketplaceSource: string;
  readonly hostBridgePath?: string;
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
  readonly installPortable?: typeof installPortableIntegration;
  readonly now?: () => number;
  readonly verifyConnection?: (context: {
    readonly configPath: string;
    readonly profileName: string;
    readonly hosts: readonly AgentHost[];
    readonly portableIntegration?: PortableIntegration;
  }) => Promise<void>;
}

export const connectHost = async (
  input: ConnectInput,
  dependencies: ConnectDependencies,
): Promise<{
  readonly hosts: readonly AgentHost[];
  readonly profileName: string;
  readonly expiresIn?: number;
  readonly configPath: string;
  readonly portableIntegration?: PortableIntegration;
  readonly credentialAction?: "reused" | "created" | "rotated";
  readonly migration?: {
    readonly operationId: string;
    readonly actions: readonly string[];
    readonly legacyPreserved: boolean;
  };
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
    throw new Error(`ArtifactPass health check failed (${health.status})`);
  }
  const configPath = input.configPath ?? defaultLocalConfigPath();
  let migration: Awaited<ReturnType<typeof migrateLegacyLocalState>> | undefined;
  if (input.configPath === undefined) {
    migration = await (dependencies.migrateState ?? migrateLegacyLocalState)({
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
        `Disconnect the existing hosted ArtifactPass ${profileName} profile before replacing it with open development`,
      );
    }
  }
  const runner = dependencies.runner ?? runProcess;
  const installKnownHostAdapters = input.installKnownHostAdapters !== false;
  const hosts = installKnownHostAdapters ? (input.hosts ?? await detectHosts(runner)) : [];
  const portableIntegration = installKnownHostAdapters && hosts.length === 0
    ? await (dependencies.installPortable ?? installPortableIntegration)({
        sourceRoot: resolve(input.marketplaceSource, "plugins/artifactpass"),
      })
    : undefined;
  const installAndVerify = async (): Promise<() => Promise<void>> => {
    const hostInstallation = installKnownHostAdapters && hosts.length > 0
      ? await installPluginForHosts(hosts, input.marketplaceSource, {
          configPath,
          profileName,
          bridgePath: resolve(
            input.hostBridgePath ?? resolve(
              input.marketplaceSource,
              "plugins/artifactpass/dist/cli.mjs",
            ),
          ),
        }, runner)
      : undefined;
    try {
      await dependencies.verifyConnection?.({
        configPath,
        profileName,
        hosts,
        ...(portableIntegration === undefined ? {} : { portableIntegration }),
      });
      return hostInstallation?.rollback ?? (async () => undefined);
    } catch (error) {
      if (hostInstallation !== undefined) {
        try {
          await hostInstallation.rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "ArtifactPass verification failed and host rollback was incomplete");
        }
      }
      throw error;
    }
  };
  if (openDevelopment) {
    try {
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
      await installAndVerify();
    } catch (error) {
      const restore = previousSettings === null
        ? rm(configPath, { force: true })
        : (dependencies.writeSettings ?? writeLocalBridgeSettings)(configPath, previousSettings);
      await restore.catch((rollbackError: unknown) => {
        throw new AggregateError([error, rollbackError], "ArtifactPass local connection failed and rollback was incomplete");
      });
      throw error;
    }
    return {
      hosts,
      profileName,
      configPath,
      ...(portableIntegration === undefined ? {} : { portableIntegration }),
      ...(migration === undefined ? {} : { migration }),
    };
  }
  const previousToken = await store.get();
  if (previousToken !== null && previousProfile === undefined) {
    throw new Error(`The existing ArtifactPass ${profileName} credential has no matching profile; disconnect it first`);
  }
  if (
    previousToken !== null &&
    previousProfile !== undefined &&
    previousProfile.open_development !== true
  ) {
    const inspection = await inspectToken(origin, previousToken, fetchImplementation);
    if (inspection !== null) {
      if (previousSettings === null) throw new Error("ArtifactPass profile state disappeared");
      try {
        await (dependencies.writeSettings ?? writeLocalBridgeSettings)(configPath, upsertLocalBridgeProfile(
          previousSettings,
          profileName,
          {
            base_url: origin.toString(),
            workspace_roots: roots,
            ...(previousProfile.publication_state === "legacy" ? { publication_state: "legacy" } : {}),
            ...(previousProfile.publication_state_path === undefined
              ? {}
              : { publication_state_path: previousProfile.publication_state_path }),
            credential_namespace: "artifactpass",
            ...(healthBody.pdf_provenance_key_id === undefined
              ? previousProfile.pdf_key_id === undefined ? {} : { pdf_key_id: previousProfile.pdf_key_id }
              : { pdf_key_id: healthBody.pdf_provenance_key_id }),
          },
        ));
        await installAndVerify();
      } catch (error) {
        await (dependencies.writeSettings ?? writeLocalBridgeSettings)(configPath, previousSettings)
          .catch((rollbackError: unknown) => {
            throw new AggregateError([error, rollbackError], "ArtifactPass connection verification failed and config rollback was incomplete");
          });
        throw error;
      }
      return {
        hosts,
        profileName,
        expiresIn: Math.max(0, Math.floor((inspection.expiresAt - (dependencies.now ?? Date.now)()) / 1000)),
        configPath,
        credentialAction: "reused",
        ...(portableIntegration === undefined ? {} : { portableIntegration }),
        ...(migration === undefined ? {} : { migration }),
      };
    }
  }
  const token = await (dependencies.deviceFlow ?? completeDeviceFlow)(
    origin.toString(),
    dependencies.deviceFlowDependencies,
  );
  let wroteConfig = false;
  let rollbackHostInstallation: (() => Promise<void>) | undefined;
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
    rollbackHostInstallation = await installAndVerify();
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
    await rollbackHostInstallation?.().catch((cleanupError: unknown) => {
      cleanupErrors.push(cleanupError);
    });
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
      throw new AggregateError([error, ...cleanupErrors], "ArtifactPass connection failed and cleanup was incomplete");
    }
    throw error;
  }
  return {
    hosts,
    profileName,
    expiresIn: token.expiresIn,
    configPath,
    credentialAction: previousToken === null ? "created" : "rotated",
    ...(portableIntegration === undefined ? {} : { portableIntegration }),
    ...(migration === undefined ? {} : { migration }),
  };
};
