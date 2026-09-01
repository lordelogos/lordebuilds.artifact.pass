import { createHash } from "node:crypto";

import type {
  DeployInput,
  IdentityRule,
  PrivateAccessConfiguration,
} from "../cloudflare/deployment";
import { storageLifecycleForMaximumExpiry } from "../cloudflare/retention-policy";
import type { PrivateDeploymentState } from "./deployment-state";

export const privateDeploymentSpecificationVersion = 1 as const;

export interface PrivateDeploymentSpecification {
  readonly version: typeof privateDeploymentSpecificationVersion;
  readonly deployment_id: string;
  readonly account_id: string;
  readonly zone_id: string;
  readonly zone_name: string;
  readonly hostname: string;
  readonly service_name: string;
  readonly placement: "automatic";
  readonly workers_subdomain: string;
  readonly workers_subdomain_action: "reuse" | "create-after-approval";
  readonly identity: {
    readonly mode: "email-code" | "company-login";
    readonly provider_ids: readonly string[];
    readonly provider_action: "reuse" | "create-after-approval";
    readonly provider_display_digest: string;
    readonly auto_redirect: boolean;
    readonly rules: readonly IdentityRule[];
  };
  readonly retention: {
    readonly allowed_expiry_seconds: readonly number[];
    readonly maximum_expiry_seconds: number;
    readonly lifecycle_rule_id: string;
    readonly lifecycle: ReturnType<typeof storageLifecycleForMaximumExpiry>;
  };
  readonly authorization: {
    readonly source: "oauth" | "api-token";
    readonly client_environment: "staging" | "production" | "api-token";
    readonly profile: "emailCode" | "companyLogin";
    readonly granted_scopes: readonly string[];
  };
}

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const serviceNamePattern = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

const requiredResource = (state: PrivateDeploymentState, name: string): string => {
  const value = state.resources?.[name];
  if (value === undefined) throw new Error(`Private deployment is missing ${name.replaceAll("_", " ")}`);
  return value;
};

const parseJsonResource = <Result>(state: PrivateDeploymentState, name: string): Result => {
  try {
    return JSON.parse(requiredResource(state, name)) as Result;
  } catch {
    throw new Error(`Private deployment contains invalid ${name.replaceAll("_", " ")}`);
  }
};

const authorizationEvidence = (state: PrivateDeploymentState): Record<string, unknown> => {
  const evidence = state.checkpoints["cloudflare-authorized"]?.evidence;
  if (evidence === undefined) throw new Error("Cloudflare authorization must be proven before deployment approval");
  return evidence as Record<string, unknown>;
};

export const canonicalPrivateDeploymentSpecification = (
  specification: PrivateDeploymentSpecification,
): string => JSON.stringify(specification);

export const privateDeploymentSpecificationDigest = (
  specification: PrivateDeploymentSpecification,
): string => createHash("sha256").update(canonicalPrivateDeploymentSpecification(specification)).digest("hex");

export const compilePrivateDeploymentSpecification = (
  state: PrivateDeploymentState,
  options: { readonly hostname?: string; readonly serviceName?: string } = {},
): PrivateDeploymentSpecification => {
  const accountId = state.cloudflare?.account_id;
  const zoneId = state.cloudflare?.zone_id;
  const zoneName = state.cloudflare?.zone_name;
  if (accountId === undefined || zoneId === undefined || zoneName === undefined) {
    throw new Error("Cloudflare account and active domain must be selected before deployment approval");
  }
  const hostname = (options.hostname ?? state.hostname ?? `artifacts.${zoneName}`).trim().toLowerCase();
  if (!hostnamePattern.test(hostname) || (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`))) {
    throw new Error("Private deployment hostname must belong to the selected Cloudflare domain");
  }
  const serviceName = options.serviceName ?? state.service_name ?? `artifactpass-${state.deployment_id.slice(0, 8)}`;
  if (!serviceNamePattern.test(serviceName)) throw new Error("Private deployment service name is invalid");

  const providerIds = parseJsonResource<unknown>(state, "identity_provider_ids");
  const rules = parseJsonResource<unknown>(state, "access_identity_rules");
  if (!Array.isArray(providerIds) || !providerIds.every((value) => typeof value === "string")) {
    throw new Error("Private deployment identity provider IDs are invalid");
  }
  if (!Array.isArray(rules) || !rules.every((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const rule = value as Record<string, unknown>;
    return ["authenticated", "domain", "email"].includes(String(rule.kind)) && typeof rule.value === "string";
  })) {
    throw new Error("Private deployment identity rules are invalid");
  }
  const providerAction = requiredResource(state, "identity_provider_action");
  const identityMode = requiredResource(state, "identity_mode");
  const autoRedirect = requiredResource(state, "access_auto_redirect");
  const providerDisplayDigest = state.checkpoints["identity-ready"]?.evidence.provider_display_digest;
  if (
    (providerAction !== "reuse" && providerAction !== "create-after-approval") ||
    (identityMode !== "email-code" && identityMode !== "company-login") ||
    (autoRedirect !== "true" && autoRedirect !== "false") ||
    typeof providerDisplayDigest !== "string" || !digestPattern.test(providerDisplayDigest)
  ) {
    throw new Error("Private deployment identity plan is incomplete");
  }
  const retention = state.retention_seconds;
  if (retention === undefined || retention.length === 0) throw new Error("Choose private link lifetimes before approval");
  const maximumExpirySeconds = retention.at(-1) as number;
  const lifecycle = storageLifecycleForMaximumExpiry(maximumExpirySeconds);
  const lifecycleRule = lifecycle.rules[0] as { readonly id?: unknown } | undefined;
  if (typeof lifecycleRule?.id !== "string") throw new Error("Private retention lifecycle is invalid");

  const authorization = authorizationEvidence(state);
  const clientEnvironment = authorization.client_environment;
  const profile = authorization.profile;
  const grantedScopes = authorization.granted_scopes;
  const source = authorization.source ?? "oauth";
  if (
    (source !== "oauth" && source !== "api-token") ||
    (clientEnvironment !== "staging" && clientEnvironment !== "production" && clientEnvironment !== "api-token") ||
    (profile !== "emailCode" && profile !== "companyLogin") ||
    !Array.isArray(grantedScopes) || !grantedScopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("Saved Cloudflare authorization evidence is incomplete");
  }

  const workersSubdomainAction = requiredResource(state, "workers_subdomain_action");
  if (workersSubdomainAction !== "reuse" && workersSubdomainAction !== "create-after-approval") {
    throw new Error("Private deployment Workers subdomain plan is invalid");
  }
  if (requiredResource(state, "placement") !== "automatic") {
    throw new Error("Private deployment placement must be Automatic");
  }

  return {
    version: privateDeploymentSpecificationVersion,
    deployment_id: state.deployment_id,
    account_id: accountId,
    zone_id: zoneId,
    zone_name: zoneName,
    hostname,
    service_name: serviceName,
    placement: "automatic",
    workers_subdomain: requiredResource(state, "workers_subdomain"),
    workers_subdomain_action: workersSubdomainAction,
    identity: {
      mode: identityMode,
      provider_ids: providerIds,
      provider_action: providerAction,
      provider_display_digest: providerDisplayDigest,
      auto_redirect: autoRedirect === "true",
      rules: rules as IdentityRule[],
    },
    retention: {
      allowed_expiry_seconds: retention,
      maximum_expiry_seconds: maximumExpirySeconds,
      lifecycle_rule_id: lifecycleRule.id,
      lifecycle,
    },
    authorization: {
      source,
      client_environment: clientEnvironment,
      profile,
      granted_scopes: [...grantedScopes].sort(),
    },
  };
};

export const deploymentInputFromPrivateSpecification = (
  specification: PrivateDeploymentSpecification,
  options: Pick<DeployInput, "dryRun" | "writeApprovalManifest" | "approveManifest">,
): DeployInput => {
  const privateAccess: PrivateAccessConfiguration = {
    identityMode: specification.identity.mode,
    allowedIdpIds: specification.identity.provider_ids,
    providerAction: specification.identity.provider_action,
    providerDisplayDigest: specification.identity.provider_display_digest,
    autoRedirectToIdentity: specification.identity.auto_redirect,
  };
  return {
    deploymentId: specification.deployment_id,
    accountId: specification.account_id,
    zoneId: specification.zone_id,
    hostname: specification.hostname,
    serviceName: specification.service_name,
    identities: specification.identity.rules,
    workersSubdomain: specification.workers_subdomain,
    workersSubdomainAction: specification.workers_subdomain_action,
    privateAccess,
    allowedExpirySeconds: specification.retention.allowed_expiry_seconds,
    authorizationBinding: specification.authorization,
    ...options,
  };
};
