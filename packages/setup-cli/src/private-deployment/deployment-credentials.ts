import {
  ARTIFACTPASS_CREDENTIAL_SERVICE,
  OsCredentialStore,
  type CredentialStore,
} from "agent-bridge";

import {
  assertExactCloudflareOAuthScopes,
  refreshCloudflareOAuthToken,
  revokeCloudflareOAuthToken,
  type CloudflareOAuthAuthorization,
  type CloudflareOAuthProfile,
  type CloudflareOAuthTokenResponse,
} from "../cloudflare/oauth";
import type { CloudflareOAuthClientConfiguration } from "../cloudflare/oauth-client-config";

const credentialVersion = 1 as const;
const maximumCredentialBytes = 16 * 1024;

interface StoredDeploymentCredential {
  readonly version: typeof credentialVersion;
  readonly deployment_id: string;
  readonly client_environment: CloudflareOAuthClientConfiguration["environment"];
  readonly client_id: string;
  readonly profile: CloudflareOAuthProfile;
  readonly granted_scopes: readonly string[];
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DeploymentAuthorizationStatus {
  readonly connected: boolean;
  readonly client_environment?: CloudflareOAuthClientConfiguration["environment"];
  readonly profile?: CloudflareOAuthProfile;
  readonly granted_scopes?: readonly string[];
  readonly expires_at?: string;
  readonly refresh_available?: boolean;
}

export interface DeploymentCredentialManagerOptions {
  readonly deploymentId: string;
  readonly client: CloudflareOAuthClientConfiguration;
  readonly store?: CredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const deploymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const clientIdPattern = /^[a-f0-9]{32}$/u;

export const cloudflareDeploymentCredentialAccount = (deploymentId: string): string => {
  if (!deploymentIdPattern.test(deploymentId)) throw new Error("Choose a valid deployment ID");
  return `cloudflare-deployment:${deploymentId}`;
};

const validateStoredCredential = (
  value: string,
  expectedDeploymentId: string,
  expectedClient: CloudflareOAuthClientConfiguration,
): StoredDeploymentCredential => {
  if (Buffer.byteLength(value) > maximumCredentialBytes) throw new Error("Stored Cloudflare authorization is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored Cloudflare authorization is malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored Cloudflare authorization is malformed");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== credentialVersion ||
    candidate.deployment_id !== expectedDeploymentId ||
    candidate.client_environment !== expectedClient.environment ||
    candidate.client_id !== expectedClient.clientId ||
    (candidate.profile !== "companyLogin" && candidate.profile !== "emailCode") ||
    !Array.isArray(candidate.granted_scopes) || !candidate.granted_scopes.every((scope) => typeof scope === "string") ||
    typeof candidate.access_token !== "string" || candidate.access_token.length < 20 || candidate.access_token.length > 4096 ||
    (candidate.refresh_token !== undefined && (typeof candidate.refresh_token !== "string" || candidate.refresh_token.length < 20 || candidate.refresh_token.length > 4096)) ||
    typeof candidate.expires_at !== "string" || Number.isNaN(Date.parse(candidate.expires_at)) ||
    typeof candidate.created_at !== "string" || Number.isNaN(Date.parse(candidate.created_at)) ||
    typeof candidate.updated_at !== "string" || Number.isNaN(Date.parse(candidate.updated_at))
  ) {
    throw new Error("Stored Cloudflare authorization is malformed or belongs to another deployment");
  }
  const grantedScopes = assertExactCloudflareOAuthScopes(
    candidate.profile,
    (candidate.granted_scopes as string[]).join(" "),
  );
  return {
    version: credentialVersion,
    deployment_id: expectedDeploymentId,
    client_environment: expectedClient.environment,
    client_id: expectedClient.clientId,
    profile: candidate.profile,
    granted_scopes: grantedScopes,
    access_token: candidate.access_token,
    ...(typeof candidate.refresh_token === "string" ? { refresh_token: candidate.refresh_token } : {}),
    expires_at: candidate.expires_at,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
};

const credentialFromAuthorization = (
  deploymentId: string,
  client: CloudflareOAuthClientConfiguration,
  authorization: CloudflareOAuthAuthorization,
  now: Date,
): StoredDeploymentCredential => ({
  version: credentialVersion,
  deployment_id: deploymentId,
  client_environment: client.environment,
  client_id: client.clientId,
  profile: authorization.profile,
  granted_scopes: assertExactCloudflareOAuthScopes(authorization.profile, authorization.token.scope),
  access_token: authorization.token.access_token,
  ...(authorization.token.refresh_token === undefined ? {} : { refresh_token: authorization.token.refresh_token }),
  expires_at: new Date(now.getTime() + authorization.token.expires_in * 1000).toISOString(),
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
});

const updatedCredential = (
  credential: StoredDeploymentCredential,
  token: CloudflareOAuthTokenResponse,
  now: Date,
): StoredDeploymentCredential => ({
  ...credential,
  granted_scopes: assertExactCloudflareOAuthScopes(credential.profile, token.scope),
  access_token: token.access_token,
  ...(token.refresh_token !== undefined
    ? { refresh_token: token.refresh_token }
    : credential.refresh_token === undefined
      ? {}
      : { refresh_token: credential.refresh_token }),
  expires_at: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
  updated_at: now.toISOString(),
});

export class DeploymentCredentialManager {
  private readonly store: CredentialStore;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly now: () => Date;

  public constructor(private readonly options: DeploymentCredentialManagerOptions) {
    cloudflareDeploymentCredentialAccount(options.deploymentId);
    if (!clientIdPattern.test(options.client.clientId)) throw new Error("Cloudflare OAuth client ID is invalid");
    this.store = options.store ?? new OsCredentialStore({
      service: ARTIFACTPASS_CREDENTIAL_SERVICE,
      account: cloudflareDeploymentCredentialAccount(options.deploymentId),
    });
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async read(): Promise<StoredDeploymentCredential | null> {
    const value = await this.store.get();
    return value === null ? null : validateStoredCredential(value, this.options.deploymentId, this.options.client);
  }

  private async write(credential: StoredDeploymentCredential): Promise<void> {
    await this.store.set(JSON.stringify(credential));
  }

  public async save(authorization: CloudflareOAuthAuthorization): Promise<void> {
    await this.write(credentialFromAuthorization(
      this.options.deploymentId,
      this.options.client,
      authorization,
      this.now(),
    ));
  }

  public async status(): Promise<DeploymentAuthorizationStatus> {
    const credential = await this.read();
    if (credential === null) return { connected: false };
    return {
      connected: true,
      client_environment: credential.client_environment,
      profile: credential.profile,
      granted_scopes: credential.granted_scopes,
      expires_at: credential.expires_at,
      refresh_available: credential.refresh_token !== undefined,
    };
  }

  public async accessTokenForInspection(): Promise<string | null> {
    const credential = await this.read();
    if (credential === null || Date.parse(credential.expires_at) <= this.now().getTime()) return null;
    return credential.access_token;
  }

  public async resolveAccessToken(): Promise<string> {
    const credential = await this.read();
    if (credential === null) throw new Error("Cloudflare authorization is required; resume this deployment to reconnect");
    if (Date.parse(credential.expires_at) - this.now().getTime() > 60_000) return credential.access_token;
    if (credential.refresh_token === undefined) {
      throw new Error("Cloudflare authorization expired and cannot be refreshed; resume this deployment to reconnect");
    }
    let token: CloudflareOAuthTokenResponse;
    try {
      token = await refreshCloudflareOAuthToken(
        this.options.client.clientId,
        credential.refresh_token,
        this.fetchImplementation,
      );
    } catch {
      throw new Error("Cloudflare authorization could not be refreshed; resume this deployment to reconnect");
    }
    const updated = updatedCredential(credential, token, this.now());
    await this.write(updated);
    return updated.access_token;
  }

  public async disconnect(): Promise<{ readonly revoked: boolean; readonly removed: true }> {
    const credential = await this.read();
    let revoked = credential === null;
    try {
      if (credential !== null) {
        const tokens = [...new Set([credential.access_token, credential.refresh_token].filter((token): token is string => token !== undefined))];
        await Promise.all(tokens.map((token) => revokeCloudflareOAuthToken(
          this.options.client.clientId,
          token,
          this.fetchImplementation,
        )));
        revoked = true;
      }
    } catch {
      revoked = false;
    } finally {
      await this.store.delete();
    }
    return { revoked, removed: true };
  }
}

export interface EphemeralDeploymentCredentialSession {
  readonly resolveAccessToken: () => Promise<string>;
  readonly close: () => Promise<void>;
}

export const createEphemeralDeploymentCredentialSession = (
  client: CloudflareOAuthClientConfiguration,
  authorization: CloudflareOAuthAuthorization,
  dependencies: { readonly fetch?: typeof globalThis.fetch; readonly now?: () => Date } = {},
): EphemeralDeploymentCredentialSession => {
  let credential = credentialFromAuthorization(
    "00000000-0000-4000-8000-000000000000",
    client,
    authorization,
    (dependencies.now ?? (() => new Date()))(),
  );
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  let closed = false;
  return {
    resolveAccessToken: async () => {
      if (closed) throw new Error("Cloudflare authorization session is closed");
      if (Date.parse(credential.expires_at) - now().getTime() > 60_000) return credential.access_token;
      if (credential.refresh_token === undefined) throw new Error("Cloudflare authorization expired and cannot be refreshed");
      credential = updatedCredential(
        credential,
        await refreshCloudflareOAuthToken(client.clientId, credential.refresh_token, fetchImplementation),
        now(),
      );
      return credential.access_token;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      const tokens = [...new Set([credential.access_token, credential.refresh_token].filter((token): token is string => token !== undefined))];
      await Promise.all(tokens.map((token) => revokeCloudflareOAuthToken(client.clientId, token, fetchImplementation)));
    },
  };
};
