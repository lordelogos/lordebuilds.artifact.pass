import { access, constants } from "node:fs/promises";

import { CloudflareClient } from "../cloudflare/client";
import {
  inspectCloudflarePrerequisites,
  listCloudflareZones,
  type CloudflarePrerequisiteSnapshot,
} from "../cloudflare/discovery";
import type { DeploymentAuthorizationStatus } from "../private-deployment/deployment-credentials";
import type { PrivateDeploymentState } from "../private-deployment/deployment-state";

export type DeploymentDoctorClassification =
  | "healthy"
  | "incomplete"
  | "authorization-required"
  | "prerequisite-pending"
  | "drifted"
  | "conflict"
  | "repair-required"
  | "verification-failed";

export type DeploymentDoctorCheckStatus = "passed" | "failed" | "pending" | "skipped";

export interface DeploymentDoctorCheck {
  readonly status: DeploymentDoctorCheckStatus;
  readonly message: string;
}

export interface DeploymentDoctorResult {
  readonly version: 1;
  readonly deployment_id: string;
  readonly hostname?: string;
  readonly classification: DeploymentDoctorClassification;
  readonly checks: {
    readonly local_state: DeploymentDoctorCheck;
    readonly credential: DeploymentDoctorCheck;
    readonly cloudflare_authorization: DeploymentDoctorCheck;
    readonly prerequisites: DeploymentDoctorCheck;
    readonly resources: DeploymentDoctorCheck;
    readonly access_boundary: DeploymentDoctorCheck;
    readonly worker_health: DeploymentDoctorCheck;
    readonly retention_policy: DeploymentDoctorCheck;
    readonly last_verification: DeploymentDoctorCheck;
    readonly receipt: DeploymentDoctorCheck;
  };
  readonly next_action: string;
}

export interface DeploymentDoctorDependencies {
  readonly authorizationStatus: () => Promise<DeploymentAuthorizationStatus>;
  readonly accessTokenForInspection: () => Promise<string | null>;
  readonly createClient?: (token: string) => CloudflareClient;
  readonly inspectPrerequisites?: (
    client: CloudflareClient,
    accountId: string,
  ) => Promise<CloudflarePrerequisiteSnapshot>;
  readonly listZones?: typeof listCloudflareZones;
  readonly fetch?: typeof globalThis.fetch;
  readonly receiptExists?: (path: string) => Promise<boolean>;
  readonly now?: () => Date;
}

const passed = (message: string): DeploymentDoctorCheck => ({ status: "passed", message });
const failed = (message: string): DeploymentDoctorCheck => ({ status: "failed", message });
const pending = (message: string): DeploymentDoctorCheck => ({ status: "pending", message });
const skipped = (message: string): DeploymentDoctorCheck => ({ status: "skipped", message });

const safeRead = async (action: () => Promise<unknown>): Promise<boolean> => {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
};

const resourcesArePresent = async (
  state: PrivateDeploymentState,
  client: CloudflareClient,
): Promise<boolean> => {
  const accountId = state.cloudflare?.account_id;
  const resources = state.resources;
  if (accountId === undefined || resources === undefined) return false;
  const checks: Array<Promise<boolean>> = [];
  const add = (value: string | undefined, path: (resolved: string) => string) => {
    if (value === undefined) {
      checks.push(Promise.resolve(false));
      return;
    }
    checks.push(safeRead(() => client.request(path(value))));
  };
  add(resources.d1_database_id, (id) => `/accounts/${accountId}/d1/database/${id}`);
  add(resources.r2_bucket_name, (name) => `/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
  add(resources.access_application_id, (id) => `/accounts/${accountId}/access/apps/${id}`);
  add(resources.worker_service ?? state.service_name, (name) =>
    `/accounts/${accountId}/workers/services/${encodeURIComponent(name)}`);
  if (state.sign_in_mode === "email-code") {
    add(resources.identity_provider_id, (id) => `/accounts/${accountId}/access/identity_providers/${id}`);
  }
  return (await Promise.all(checks)).every(Boolean);
};

const prerequisiteIsReady = (snapshot: CloudflarePrerequisiteSnapshot): boolean =>
  Object.values(snapshot).every((item) => item.status === "ready");

const readJson = async (
  fetchImplementation: typeof globalThis.fetch,
  url: string,
): Promise<{ readonly response: Response; readonly body: Record<string, unknown> | null }> => {
  const response = await fetchImplementation(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  return { response, body };
};

const nextActionFor = (classification: DeploymentDoctorClassification, selector: string): string => {
  switch (classification) {
    case "healthy": return "No repair is needed.";
    case "authorization-required": return `Run pnpm dlx artifactpass deploy --resume ${selector} to reconnect Cloudflare.`;
    case "prerequisite-pending": return `Run pnpm dlx artifactpass deploy --resume ${selector} to finish the pending Cloudflare setup.`;
    case "repair-required": return `Run pnpm dlx artifactpass deploy --resume ${selector} and choose the repair path.`;
    case "drifted": return `Run pnpm dlx artifactpass deploy --resume ${selector} to review and repair changed resources.`;
    case "conflict": return "Stop and review the recorded account, domain, and resource ownership before retrying.";
    case "verification-failed": return `Run pnpm dlx artifactpass deployment doctor --resume ${selector} again, then resume deployment if the failure remains.`;
    case "incomplete": return `Run pnpm dlx artifactpass deploy --resume ${selector} to continue setup.`;
  }
};

export const runPrivateDeploymentDoctor = async (
  state: PrivateDeploymentState,
  dependencies: DeploymentDoctorDependencies,
): Promise<DeploymentDoctorResult> => {
  const selector = state.hostname ?? state.deployment_id;
  const localState = passed(`Local deployment state is valid at stage ${state.stage}.`);
  const authorization = await dependencies.authorizationStatus()
    .catch((): DeploymentAuthorizationStatus => ({ connected: false }));
  const expiresAt = authorization.expires_at === undefined ? Number.NaN : Date.parse(authorization.expires_at);
  const credentialActive = authorization.connected && Number.isFinite(expiresAt) &&
    expiresAt > (dependencies.now ?? (() => new Date()))().getTime();
  const credential = credentialActive
    ? passed("A deployment credential is present in the OS credential store.")
    : failed("No unexpired deployment credential is available.");
  let cloudflareAuthorization = skipped("Cloudflare was not queried without an active credential.");
  let prerequisites = skipped("Cloudflare prerequisites were not queried.");
  let resources = skipped("Cloudflare resources were not queried.");
  let accessBoundary = skipped("The private Access boundary was not queried.");
  let workerHealth = skipped("Worker health was not queried.");
  let retentionPolicy = skipped("The deployment policy was not queried.");

  if (credentialActive) {
    const token = await dependencies.accessTokenForInspection().catch(() => null);
    if (token === null) {
      cloudflareAuthorization = failed("The stored Cloudflare authorization is expired or unavailable.");
    } else {
      const client = (dependencies.createClient ?? ((value) => new CloudflareClient({ token: value })))(token);
      const authorized = await safeRead(() => client.verifyToken());
      cloudflareAuthorization = authorized
        ? passed("Cloudflare accepted the stored authorization.")
        : failed("Cloudflare rejected the stored authorization.");
      if (authorized) {
        const accountId = state.cloudflare?.account_id;
        if (accountId === undefined) {
          prerequisites = failed("No Cloudflare account is recorded.");
          resources = failed("Resource ownership cannot be checked without an account.");
        } else {
          const snapshot = await (dependencies.inspectPrerequisites ?? inspectCloudflarePrerequisites)(client, accountId)
            .catch(() => null);
          const zones = await (dependencies.listZones ?? listCloudflareZones)(client, accountId)
            .catch(() => []);
          const zone = zones.find((item) => item.id === state.cloudflare?.zone_id);
          prerequisites = snapshot !== null && prerequisiteIsReady(snapshot) && zone?.status === "active"
            ? passed("D1, R2, Zero Trust, Workers, and the domain are ready.")
            : pending("One or more Cloudflare prerequisites are not ready.");
          resources = await resourcesArePresent(state, client)
            ? passed("Every recorded Cloudflare resource is present.")
            : failed("One or more recorded Cloudflare resources are missing or inaccessible.");
        }
      }
    }
  }

  if (state.hostname !== undefined) {
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    const origin = `https://${state.hostname}`;
    const [health, session, upload] = await Promise.all([
      readJson(fetchImplementation, `${origin}/health`).catch(() => null),
      readJson(fetchImplementation, `${origin}/session/status`).catch(() => null),
      fetchImplementation(`${origin}/upload`, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null),
    ]);
    workerHealth = health?.response.ok === true && health.body?.status === "ok" &&
      health.body.deployment_id === state.deployment_id
      ? passed("The Worker is healthy and bound to this deployment ID.")
      : failed("Worker health does not match this deployment.");
    const protectedStatus = upload === null ? 0 : upload.status;
    accessBoundary = [302, 303, 307, 401, 403].includes(protectedStatus)
      ? passed("Cloudflare Access protects the upload route.")
      : failed("The upload route is not protected by the expected Access boundary.");
    const policy = session?.body?.policy;
    const expiry = policy !== null && typeof policy === "object"
      ? (policy as Record<string, unknown>).expiry
      : null;
    const allowed = expiry !== null && typeof expiry === "object"
      ? (expiry as Record<string, unknown>).allowed_seconds
      : null;
    retentionPolicy = session?.response.ok === true &&
      session.body?.deployment_mode === "private" &&
      Array.isArray(allowed) && JSON.stringify(allowed) === JSON.stringify(state.retention_seconds)
      ? passed("The live private retention policy matches local state.")
      : failed("The live retention policy does not match local state.");
  }

  const verification = state.checkpoints["hosted-verification"];
  const lastVerification = verification?.evidence.health === "passed" &&
    verification.evidence.protected_upload === "passed"
    ? passed(`The last hosted verification passed at ${verification.proven_at}.`)
    : failed("No successful hosted verification is recorded.");
  const receiptPath = state.resources?.deployment_receipt_path;
  const receiptPresent = receiptPath !== undefined && await (
    dependencies.receiptExists ?? ((path) => access(path, constants.R_OK).then(() => true).catch(() => false))
  )(receiptPath);
  const receipt = receiptPresent
    ? passed("The redacted deployment receipt is present.")
    : state.status === "complete"
      ? failed("The deployment receipt is missing.")
      : skipped("A receipt is created after successful deployment.");

  let classification: DeploymentDoctorClassification;
  if (state.status === "abandoned") classification = "conflict";
  else if (state.stage === "repair-required") classification = "repair-required";
  else if (!credentialActive || cloudflareAuthorization.status === "failed") classification = "authorization-required";
  else if (state.pending_handoff !== undefined || prerequisites.status === "pending") classification = "prerequisite-pending";
  else if (state.status !== "complete" || state.stage !== "complete") classification = "incomplete";
  else if (resources.status === "failed") classification = "drifted";
  else if ([workerHealth, accessBoundary, retentionPolicy, lastVerification, receipt].some((check) => check.status === "failed")) {
    classification = "verification-failed";
  }
  else classification = "healthy";

  return {
    version: 1,
    deployment_id: state.deployment_id,
    ...(state.hostname === undefined ? {} : { hostname: state.hostname }),
    classification,
    checks: {
      local_state: localState,
      credential,
      cloudflare_authorization: cloudflareAuthorization,
      prerequisites,
      resources,
      access_boundary: accessBoundary,
      worker_health: workerHealth,
      retention_policy: retentionPolicy,
      last_verification: lastVerification,
      receipt,
    },
    next_action: nextActionFor(classification, selector),
  };
};

export const renderPrivateDeploymentDoctor = (result: DeploymentDoctorResult): string => [
  `ArtifactPass private deployment: ${result.hostname ?? result.deployment_id}`,
  `Status: ${result.classification}`,
  ...Object.entries(result.checks).map(([name, check]) =>
    `${check.status === "passed" ? "OK" : check.status === "skipped" ? "SKIP" : check.status.toUpperCase()} ${name.replaceAll("_", " ")}: ${check.message}`),
  `Next: ${result.next_action}`,
].join("\n");
