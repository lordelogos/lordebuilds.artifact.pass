import {
  ARTIFACTPASS_CREDENTIAL_SERVICE,
  CompatibleCredentialStore,
  LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
  OsCredentialStore,
  agentCredentialAccountForProfile,
  assertSafeDeploymentOrigin,
  selectLocalBridgeProfile,
  type CredentialStore,
  type LocalBridgeSettings,
} from "agent-bridge";

export const selectDisconnectProfile = (
  settings: LocalBridgeSettings,
  options: { readonly profileName?: string; readonly baseUrl?: string },
): ReturnType<typeof selectLocalBridgeProfile> => {
  if (options.profileName !== undefined) {
    const selected = selectLocalBridgeProfile(settings, options.profileName);
    if (
      options.baseUrl !== undefined &&
      new URL(selected.settings.base_url).toString() !== new URL(options.baseUrl).toString()
    ) {
      throw new Error(`ArtifactPass profile ${selected.name} does not use ${options.baseUrl}`);
    }
    return selected;
  }
  if (options.baseUrl === undefined) return selectLocalBridgeProfile(settings);
  const requestedUrl = new URL(options.baseUrl).toString();
  const matches = Object.entries(settings.profiles)
    .filter(([, profile]) => new URL(profile.base_url).toString() === requestedUrl)
    .map(([name]) => name);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `No ArtifactPass profile uses ${options.baseUrl}`
      : `More than one ArtifactPass profile uses ${options.baseUrl}; specify --profile`);
  }
  return selectLocalBridgeProfile(settings, matches[0] ?? "");
};

export const disconnectHost = async (
  baseUrl: string,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly credentialStore?: CredentialStore;
    readonly profileName?: string;
  } = {},
): Promise<void> => {
  const account = agentCredentialAccountForProfile(options.profileName ?? "production");
  const store = options.credentialStore ?? new CompatibleCredentialStore({
    artifactpassStore: new OsCredentialStore({
      service: ARTIFACTPASS_CREDENTIAL_SERVICE,
      account,
    }),
    legacyStore: new OsCredentialStore({
      service: LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
      account,
    }),
    migrationCommitted: true,
  });
  const token = await store.get();
  if (token === null) return;
  const origin = assertSafeDeploymentOrigin(new URL(baseUrl));
  const response = await (options.fetch ?? globalThis.fetch)(new URL("/api/connection", origin), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not revoke ArtifactPass connection (${response.status})`);
  }
  await store.delete();
};
