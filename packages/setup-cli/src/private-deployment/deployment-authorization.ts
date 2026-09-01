import type { CredentialStore } from "agent-bridge";

import {
  authorizeCloudflareOAuth,
  type CloudflareOAuthDependencies,
  type CloudflareOAuthProfile,
} from "../cloudflare/oauth";
import {
  resolveCloudflareOAuthClientConfiguration,
  type CloudflareOAuthClientConfiguration,
} from "../cloudflare/oauth-client-config";
import {
  DeploymentCredentialManager,
  createEphemeralDeploymentCredentialSession,
  type DeploymentAuthorizationStatus,
} from "./deployment-credentials";
import type { PrivateDeploymentState } from "./deployment-state";

export interface PrivateDeploymentAuthorizationSession {
  readonly persisted: boolean;
  readonly client?: CloudflareOAuthClientConfiguration;
  readonly profile: CloudflareOAuthProfile;
  readonly grantedScopes: readonly string[];
  readonly source: "oauth" | "api-token";
  readonly resolveAccessToken: () => Promise<string>;
  readonly close: () => Promise<void>;
}

export interface PrivateDeploymentAuthorizationDependencies {
  readonly oauth: CloudflareOAuthDependencies;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly credentialStore?: CredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const profileForState = (state: PrivateDeploymentState): CloudflareOAuthProfile => {
  if (state.sign_in_mode === "email-code") return "emailCode";
  if (state.sign_in_mode === "company-login") return "companyLogin";
  throw new Error("Choose how people sign in before authorizing Cloudflare");
};

const credentialManager = (
  state: PrivateDeploymentState,
  client: CloudflareOAuthClientConfiguration,
  dependencies: Omit<PrivateDeploymentAuthorizationDependencies, "oauth">,
): DeploymentCredentialManager => new DeploymentCredentialManager({
  deploymentId: state.deployment_id,
  client,
  ...(dependencies.credentialStore === undefined ? {} : { store: dependencies.credentialStore }),
  ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
});

export const authorizePrivateDeployment = async (
  state: PrivateDeploymentState,
  noSaveAuthorization: boolean,
  dependencies: PrivateDeploymentAuthorizationDependencies,
): Promise<PrivateDeploymentAuthorizationSession> => {
  const environment = dependencies.environment ?? process.env;
  const profile = profileForState(state);
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (apiToken !== undefined && apiToken.length > 0) {
    if (apiToken.length < 20 || apiToken.length > 4096) {
      throw new Error("CLOUDFLARE_API_TOKEN is malformed");
    }
    return {
      persisted: false,
      source: "api-token",
      profile,
      grantedScopes: [],
      resolveAccessToken: async () => apiToken,
      close: async () => undefined,
    };
  }
  const client = resolveCloudflareOAuthClientConfiguration(environment);
  const manager = credentialManager(state, client, dependencies);
  if (!noSaveAuthorization) {
    try {
      const status = await manager.status();
      if (status.connected && status.profile === profile) {
        await manager.resolveAccessToken();
        return {
          persisted: true,
          source: "oauth",
          client,
          profile,
          grantedScopes: status.granted_scopes ?? [],
          resolveAccessToken: () => manager.resolveAccessToken(),
          close: async () => undefined,
        };
      }
    } catch {
      // A stale, revoked, or differently bound grant is replaced by a fresh
      // authorization without touching the deployment's non-secret progress.
    }
  }
  const authorization = await authorizeCloudflareOAuth(client.clientId, profile, {
    ...dependencies.oauth,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  if (noSaveAuthorization) {
    const session = createEphemeralDeploymentCredentialSession(client, authorization, {
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    return {
      persisted: false,
      source: "oauth",
      client,
      profile,
      grantedScopes: authorization.grantedScopes,
      ...session,
    };
  }
  await manager.save(authorization);
  return {
    persisted: true,
    source: "oauth",
    client,
    profile,
    grantedScopes: authorization.grantedScopes,
    resolveAccessToken: () => manager.resolveAccessToken(),
    close: async () => undefined,
  };
};

export const privateDeploymentAuthorizationStatus = async (
  state: PrivateDeploymentState,
  dependencies: Omit<PrivateDeploymentAuthorizationDependencies, "oauth"> = {},
): Promise<DeploymentAuthorizationStatus> => {
  const client = resolveCloudflareOAuthClientConfiguration(dependencies.environment);
  return credentialManager(state, client, dependencies).status();
};

export const disconnectPrivateDeploymentAuthorization = async (
  state: PrivateDeploymentState,
  dependencies: Omit<PrivateDeploymentAuthorizationDependencies, "oauth"> = {},
): Promise<{ readonly revoked: boolean; readonly removed: true }> => {
  const client = resolveCloudflareOAuthClientConfiguration(dependencies.environment);
  return credentialManager(state, client, dependencies).disconnect();
};
