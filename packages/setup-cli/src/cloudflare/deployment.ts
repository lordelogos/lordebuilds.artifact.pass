import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { PUBLIC_EXPIRY_POLICY } from "artifact-protocol";

import type { ProcessRunner } from "../process";
import { runProcess } from "../process";
import { CloudflareApiError, CloudflareClient } from "./client";
import { fetchCloudflareDeploymentRoute } from "./deployment-readiness";
import { listCloudflareIdentityProviders } from "./identity";
import { storageLifecycleForMaximumExpiry } from "./retention-policy";

export interface IdentityRule {
  readonly kind: "authenticated" | "email" | "domain";
  readonly value: string;
}

export interface PrivateAccessConfiguration {
  readonly identityMode: "email-code" | "company-login";
  readonly allowedIdpIds: readonly string[];
  readonly providerAction?: "reuse" | "create-after-approval";
  readonly providerDisplayDigest?: string;
  readonly autoRedirectToIdentity: boolean;
}

export interface DeployInput {
  readonly deploymentId?: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly hostname: string;
  readonly identities: readonly IdentityRule[];
  readonly dryRun: boolean;
  readonly pdfKeyId?: string;
  readonly pdfPublicKey?: string;
  readonly workersSubdomain: string;
  readonly workersSubdomainAction?: "reuse" | "create-after-approval";
  readonly serviceName?: string;
  readonly writeApprovalManifest?: string;
  readonly approveManifest?: string;
  readonly publicAuth?: {
    readonly googleClientId: string;
    readonly googleClientSecret: string;
    readonly githubClientId: string;
    readonly githubClientSecret: string;
  };
  readonly productionExistingResources?: boolean;
  readonly privateAccess?: PrivateAccessConfiguration;
  readonly allowedExpirySeconds?: readonly number[];
  readonly authorizationBinding?: {
    readonly source: "oauth" | "api-token";
    readonly client_environment: "staging" | "production" | "api-token";
    readonly profile: "emailCode" | "companyLogin";
    readonly granted_scopes: readonly string[];
  };
}

export interface DeploymentResult {
  readonly baseUrl: string;
  readonly teamCommand: string;
  readonly plan: readonly string[];
  readonly changed: readonly string[];
  readonly approvalManifest?: string;
  readonly resources?: Readonly<Record<string, string>>;
  readonly verification?: {
    readonly health: "passed";
    readonly protectedUpload: "passed";
    readonly verifiedAt: string;
  };
}

export class DeploymentMutationError extends Error {
  constructor(
    message: string,
    readonly changed: readonly string[],
    readonly resources: Readonly<Record<string, string>>,
    cause: unknown,
    readonly rolledBack: readonly string[] = [],
    readonly rollbackFailures: readonly string[] = [],
  ) {
    super(message, { cause });
    this.name = "DeploymentMutationError";
  }
}

interface Database { readonly uuid: string; readonly name: string }
interface Bucket { readonly name: string }
interface AccessApplication {
  readonly id: string;
  readonly name: string;
  readonly aud: string;
  readonly destinations?: readonly { readonly type: string; readonly uri?: string }[];
  readonly allowed_idps?: readonly string[];
  readonly auto_redirect_to_identity?: boolean;
}
interface AccessPolicy {
  readonly id: string;
  readonly name: string;
  readonly decision?: string;
  readonly include?: readonly unknown[];
}
interface AccessOrganization { readonly auth_domain: string }
interface WorkerDomain { readonly hostname: string; readonly service: string }
interface WorkerScript { readonly id: string; readonly modified_on?: string; readonly etag?: string }
interface DeploymentMarker {
  readonly version: 1;
  readonly deployment_id: string;
  readonly bucket_name: string;
  readonly creation_operation_id: string;
  readonly manifest_digest: string;
}

interface ApprovalManifest {
  readonly version: 2 | 3 | 4;
  readonly generated_at: string;
  readonly binding: {
    readonly input: {
      readonly accountId: string;
      readonly deploymentId?: string;
      readonly zoneId: string;
      readonly hostname: string;
      readonly identities: readonly IdentityRule[];
      readonly serviceName: string;
      readonly pdfKeyId?: string;
      readonly pdfPublicKeySha256?: string;
      readonly workersSubdomain: string;
      readonly workersSubdomainAction?: "reuse" | "create-after-approval";
      readonly authMode: "cloudflare-access" | "artifactpass";
      readonly googleClientId?: string;
      readonly googleClientSecretSha256?: string;
      readonly githubClientId?: string;
      readonly githubClientSecretSha256?: string;
      readonly privateAccess?: PrivateAccessConfiguration;
      readonly productionExistingResources?: boolean;
      readonly allowedExpirySeconds?: readonly number[];
      readonly authorizationBinding?: DeployInput["authorizationBinding"];
    };
    readonly bundleSha256: string;
    readonly remote: unknown;
  };
}

const identifier = /^[a-f0-9]{32}$/u;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const workersSubdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const serviceNamePattern = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u;
const deploymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const deploymentPlan = (input: DeployInput): readonly string[] => {
  if (!identifier.test(input.accountId) || !identifier.test(input.zoneId)) {
    throw new Error("Cloudflare account and zone IDs must be 32 lowercase hexadecimal characters");
  }
  if (!hostnamePattern.test(input.hostname)) throw new Error("Choose a valid lowercase hostname");
  if (input.serviceName !== undefined && !serviceNamePattern.test(input.serviceName)) {
    throw new Error("Choose a valid lowercase Cloudflare service name");
  }
  if (input.deploymentId !== undefined && !deploymentIdPattern.test(input.deploymentId)) {
    throw new Error("Choose a valid private deployment ID");
  }
  if ((input.pdfKeyId === undefined) !== (input.pdfPublicKey === undefined)) {
    throw new Error("PDF signing key ID and public key must be provided together");
  }
  if (input.pdfKeyId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/u.test(input.pdfKeyId)) {
    throw new Error("Choose a valid PDF signing key ID");
  }
  if (input.pdfPublicKey !== undefined && !/^[A-Za-z0-9+/]{43}=$/u.test(input.pdfPublicKey)) {
    throw new Error("PDF public key must be one base64-encoded Ed25519 raw key");
  }
  if (!workersSubdomainPattern.test(input.workersSubdomain)) {
    throw new Error("Choose a valid Workers account subdomain");
  }
  if (input.publicAuth === undefined && input.identities.length === 0) {
    throw new Error("At least one allowed identity is required");
  }
  if (input.publicAuth !== undefined && input.identities.length > 0) {
    throw new Error("Public ArtifactPass authentication cannot include Cloudflare Access identities");
  }
  if (input.publicAuth !== undefined && input.privateAccess !== undefined) {
    throw new Error("Public ArtifactPass authentication cannot include private Access configuration");
  }
  if (input.productionExistingResources === true && input.publicAuth === undefined) {
    throw new Error("Production existing-resource mode requires public ArtifactPass authentication");
  }
  if (
    input.productionExistingResources === true &&
    !input.dryRun &&
    input.writeApprovalManifest === undefined &&
    input.approveManifest === undefined
  ) {
    throw new Error("Production deployment requires an approval manifest");
  }
  if (input.publicAuth !== undefined && input.allowedExpirySeconds !== undefined) {
    throw new Error("Public ArtifactPass expiry policy is fixed by the hosted service");
  }
  for (const identity of input.identities) {
    const valid = identity.kind === "authenticated"
      ? identity.value === "selected-providers"
      : identity.kind === "email"
      ? /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(identity.value)
      : hostnamePattern.test(`x.${identity.value}`);
    if (!valid) throw new Error(`Allowed ${identity.kind} is invalid`);
  }
  if (input.privateAccess !== undefined) {
    const providerAction = input.privateAccess.providerAction ?? "reuse";
    if (
      (providerAction === "reuse" && input.privateAccess.allowedIdpIds.length === 0) ||
      (providerAction === "create-after-approval" && (
        input.privateAccess.identityMode !== "email-code" || input.privateAccess.allowedIdpIds.length !== 0
      )) ||
      input.privateAccess.allowedIdpIds.length > 20 ||
      new Set(input.privateAccess.allowedIdpIds).size !== input.privateAccess.allowedIdpIds.length ||
      !input.privateAccess.allowedIdpIds.every((id) => /^[A-Za-z0-9_-]{1,128}$/u.test(id))
    ) {
      throw new Error("Private Access requires one or more valid identity provider IDs");
    }
    if (input.privateAccess.autoRedirectToIdentity !== (
      input.privateAccess.allowedIdpIds.length === 1 || providerAction === "create-after-approval"
    )) {
      throw new Error("Direct identity redirect requires exactly one provider");
    }
    if (input.privateAccess.identityMode === "email-code" && input.identities.some((identity) => identity.kind === "authenticated")) {
      throw new Error("Email verification code cannot allow every internet email address");
    }
    if (input.privateAccess.identityMode === "company-login" && input.identities.some((identity) => identity.kind !== "authenticated")) {
      throw new Error("Company login is restricted by its selected providers");
    }
  }
  if (input.deploymentId !== undefined && input.approveManifest === undefined && input.writeApprovalManifest === undefined) {
    throw new Error("Private deployment mutation requires an approval manifest");
  }
  if (input.allowedExpirySeconds !== undefined) {
    if (
      input.allowedExpirySeconds.length === 0 ||
      new Set(input.allowedExpirySeconds).size !== input.allowedExpirySeconds.length ||
      input.allowedExpirySeconds.some((value, index) =>
        !Number.isInteger(value) || value <= 0 || value > 604_800 ||
        (index > 0 && value <= (input.allowedExpirySeconds?.[index - 1] ?? 0)))
    ) {
      throw new Error("Private expiry values must be non-empty, unique, increasing, and no more than seven days");
    }
  }
  if (input.publicAuth !== undefined) {
    for (const [name, credential] of Object.entries(input.publicAuth)) {
      if (credential.trim().length === 0 || credential.length > 512) {
        throw new Error(`${name} must be a non-empty OAuth credential`);
      }
    }
  }
  if (input.publicAuth !== undefined) {
    return [
      "verify the short-lived Cloudflare API token, selected zone, and Workers account subdomain",
      input.productionExistingResources === true
        ? "verify the approved existing Worker, D1 database, R2 bucket, custom domain, and Access gate"
        : "reuse or create the private D1 database and R2 bucket",
      "prepare the public Worker configuration with Google and GitHub OAuth secrets",
      "apply D1 migrations and the R2 cleanup lifecycle",
      input.productionExistingResources === true
        ? "deploy code and OAuth secrets atomically while retaining the Access containment gate"
        : "deploy the Worker and verify ArtifactPass authentication before removing the old Access gate",
      input.productionExistingResources === true
        ? "verify provider starts, health, and the retained Access boundary"
        : "verify public sign-in, protected upload redirection, and health",
      "print the public connection command without persisting provisioning credentials",
    ];
  }
  return [
    "verify the short-lived Cloudflare API token, selected zone, and Workers account subdomain",
    "reuse or create the private D1 database and R2 bucket",
    "reuse or create one path-scoped Access application and allow policy",
    "prepare the Worker configuration with its custom domain and private bindings",
    "apply D1 migrations and the R2 cleanup lifecycle",
    "deploy the Worker, then verify the public health route and protected upload boundary",
    "print the team connection command without persisting the provisioning token",
  ];
};

const expectedDestinations = (hostname: string) => [
  { type: "public", uri: `${hostname}/upload*` },
  { type: "public", uri: `${hostname}/connect/approve*` },
];

const identityIncludes = (identities: readonly IdentityRule[]) => identities.map((identity) =>
  identity.kind === "authenticated"
    ? { everyone: {} }
    : identity.kind === "email"
    ? { email: { email: identity.value } }
    : { email_domain: { domain: identity.value } });

const canonicalJson = (value: readonly unknown[]): string =>
  JSON.stringify([...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));

export const canonicalCloudflareValue = (value: unknown): string => JSON.stringify(value, (_key, nested) => {
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)));
});

const restoreLegacyAccess = async (
  input: DeployInput,
  serviceName: string,
  policies: readonly AccessPolicy[],
  dependencies: DeployDependencies,
): Promise<AccessApplication> => {
  const restored = await dependencies.client.request<AccessApplication>(
    `/accounts/${input.accountId}/access/apps`,
    {
      method: "POST",
      body: JSON.stringify({
        name: serviceName,
        type: "self_hosted",
        session_duration: "24h",
        destinations: expectedDestinations(input.hostname),
        ...(input.privateAccess === undefined ? {} : {
          allowed_idps: input.privateAccess.allowedIdpIds,
          auto_redirect_to_identity: input.privateAccess.autoRedirectToIdentity,
        }),
      }),
    },
  );
  for (const policy of policies) {
    await dependencies.client.request(
      `/accounts/${input.accountId}/access/apps/${restored.id}/policies`,
      {
        method: "POST",
        body: JSON.stringify({
          name: policy.name,
          decision: policy.decision ?? "allow",
          include: policy.include ?? [],
        }),
      },
    );
  }
  return restored;
};

const deploymentFiles = async (root: string, directory = root): Promise<readonly string[]> => {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const path = resolve(directory, entry);
    if ((await stat(path)).isDirectory()) files.push(...await deploymentFiles(root, path));
    else files.push(path.slice(root.length + 1));
  }
  return files;
};

const deploymentSha256 = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const path of await deploymentFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const readWorkersSubdomain = async (
  input: DeployInput,
  dependencies: DeployDependencies,
): Promise<{ readonly subdomain: string } | null> => {
  try {
    return await dependencies.client.request<{ readonly subdomain: string }>(
      `/accounts/${input.accountId}/workers/subdomain`,
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return null;
    throw error;
  }
};

const readR2DeploymentMarker = async (
  input: DeployInput,
  bucketName: string,
  dependencies: DeployDependencies,
): Promise<DeploymentMarker | null> => {
  if (input.deploymentId === undefined) return null;
  const root = await mkdtemp(resolve(tmpdir(), "artifactpass-marker-read-"));
  const output = resolve(root, "deployment.json");
  try {
    try {
      await (dependencies.runner ?? runProcess)("wrangler", [
        "r2", "object", "get", `${bucketName}/.artifactpass/deployment.json`,
        "--remote", "--file", output,
      ], { env: { CLOUDFLARE_ACCOUNT_ID: input.accountId } });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (message.includes("not found") || message.includes("does not exist") || message.includes("404")) return null;
      throw error;
    }
    const parsed = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    if (
      parsed.version !== 1 || parsed.deployment_id !== input.deploymentId ||
      parsed.bucket_name !== bucketName ||
      typeof parsed.creation_operation_id !== "string" || !deploymentIdPattern.test(parsed.creation_operation_id) ||
      typeof parsed.manifest_digest !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.manifest_digest)
    ) {
      throw new Error("Existing R2 bucket has a foreign or malformed ArtifactPass ownership marker");
    }
    return parsed as unknown as DeploymentMarker;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const approvalBinding = async (
  input: DeployInput,
  serviceName: string,
  dependencies: DeployDependencies,
): Promise<ApprovalManifest["binding"]> => {
  const [workersSubdomain, zone, domains, databases, buckets, applications, identityProviders] = await Promise.all([
    readWorkersSubdomain(input, dependencies),
    dependencies.client.request<{ readonly name: string; readonly status: string }>(`/zones/${input.zoneId}`),
    dependencies.client.request<readonly WorkerDomain[]>(`/accounts/${input.accountId}/workers/domains`),
    dependencies.client.request<readonly Database[]>(
      `/accounts/${input.accountId}/d1/database?name=${encodeURIComponent(serviceName)}`,
    ),
    dependencies.client.request<{ readonly buckets: readonly Bucket[] }>(
      `/accounts/${input.accountId}/r2/buckets`,
    ),
    dependencies.client.request<readonly AccessApplication[]>(`/accounts/${input.accountId}/access/apps`),
    input.deploymentId !== undefined
      ? listCloudflareIdentityProviders(dependencies.client, input.accountId)
      : Promise.resolve([]),
  ]);
  const application = applications.find((candidate) => candidate.name === serviceName);
  const organization = input.publicAuth !== undefined && application === undefined
    ? null
    : await dependencies.client.request<AccessOrganization>(
        `/accounts/${input.accountId}/access/organizations`,
      );
  const policies = application === undefined
    ? []
    : await dependencies.client.request<readonly {
      readonly id: string;
      readonly name: string;
      readonly decision?: string;
      readonly include?: readonly unknown[];
      }[]>(`/accounts/${input.accountId}/access/apps/${application.id}/policies`);
  const database = databases.find((candidate) => candidate.name === serviceName) ?? null;
  const bucket = buckets.buckets.find((candidate) => candidate.name === serviceName) ?? null;
  const [scripts, databaseSchema, databaseMigrations, deploymentMetadata, lifecycle, r2Marker] = await Promise.all([
    dependencies.client.request<readonly WorkerScript[]>(`/accounts/${input.accountId}/workers/scripts`),
    database === null
      ? Promise.resolve(null)
      : dependencies.client.request<readonly { readonly results?: readonly unknown[] }[]>(
          `/accounts/${input.accountId}/d1/database/${database.uuid}/query`,
          {
            method: "POST",
            body: JSON.stringify({ sql: "SELECT name, type, sql FROM sqlite_schema ORDER BY type, name" }),
          },
        ).then((queries) => queries.flatMap((query) => query.results ?? [])),
    database === null
      ? Promise.resolve(null)
      : dependencies.client.request<readonly { readonly results?: readonly { readonly name?: unknown }[] }[]>(
          `/accounts/${input.accountId}/d1/database/${database.uuid}/query`,
          {
            method: "POST",
            body: JSON.stringify({ sql: "SELECT name FROM d1_migrations ORDER BY id" }),
          },
        ).then((queries) => queries.flatMap((query) => query.results ?? []).map(({ name }) => name)),
    database === null || input.deploymentId === undefined
      ? Promise.resolve(null)
      : dependencies.client.request<readonly { readonly results?: readonly unknown[] }[]>(
          `/accounts/${input.accountId}/d1/database/${database.uuid}/query`,
          {
            method: "POST",
            body: JSON.stringify({
              sql: "SELECT deployment_id, manifest_digest, account_id, zone_id, hostname, service_name FROM deployment_metadata LIMIT 1",
            }),
          },
        ).then((queries) => queries.flatMap((query) => query.results ?? [])[0] ?? null)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
            if (message.includes("no such table")) return null;
            throw error;
          }),
    bucket === null
      ? Promise.resolve(null)
      : dependencies.client.request<unknown>(
          `/accounts/${input.accountId}/r2/buckets/${encodeURIComponent(serviceName)}/lifecycle`,
        ),
    bucket === null ? Promise.resolve(null) : readR2DeploymentMarker(input, serviceName, dependencies),
  ]);
  if (input.deploymentId !== undefined && database !== null) {
    const metadata = deploymentMetadata as Record<string, unknown> | null;
    if (metadata?.deployment_id !== input.deploymentId) {
      throw new Error("Existing D1 database is not owned by this ArtifactPass deployment");
    }
  }
  if (input.deploymentId !== undefined && bucket !== null && r2Marker?.deployment_id !== input.deploymentId) {
    throw new Error("Existing R2 bucket is not owned by this ArtifactPass deployment");
  }
  if (input.productionExistingResources === true) {
    const domain = domains.find((candidate) => candidate.hostname === input.hostname);
    const worker = scripts.find((candidate) => candidate.id === serviceName);
    const destinations = application?.destinations ?? [];
    if (
      workersSubdomain?.subdomain !== input.workersSubdomain ||
      zone.status !== "active" ||
      (input.hostname !== zone.name && !input.hostname.endsWith(`.${zone.name}`)) ||
      domain?.service !== serviceName ||
      database === null ||
      bucket === null ||
      worker === undefined ||
      application === undefined ||
      canonicalJson(destinations) !== canonicalJson(expectedDestinations(input.hostname))
    ) {
      throw new Error(
        "Production requires the approved existing Worker, D1, R2, custom domain, and Access application",
      );
    }
    const localMigrations = (await readdir(resolve(dependencies.deploymentRoot, "migrations")))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const appliedMigrations = (databaseMigrations ?? []).filter((name): name is string => typeof name === "string");
    if (appliedMigrations.some((name) => !localMigrations.includes(name))) {
      throw new Error("Production D1 has a migration that is not present in the reviewed candidate");
    }
    const pendingMigrations = localMigrations.filter((name) => !appliedMigrations.includes(name));
    if (JSON.stringify(pendingMigrations) !== JSON.stringify(["0009-cleanup-indexes.sql"])) {
      throw new Error("Production deployment requires exactly 0009-cleanup-indexes.sql to be pending");
    }
  }
  return {
    input: {
      ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
      accountId: input.accountId,
      zoneId: input.zoneId,
      hostname: input.hostname,
      identities: input.identities,
      serviceName,
      ...(input.pdfKeyId === undefined ? {} : { pdfKeyId: input.pdfKeyId }),
      ...(input.pdfPublicKey === undefined ? {} : {
        pdfPublicKeySha256: createHash("sha256").update(input.pdfPublicKey).digest("hex"),
      }),
      workersSubdomain: input.workersSubdomain,
      ...(input.workersSubdomainAction === undefined ? {} : {
        workersSubdomainAction: input.workersSubdomainAction,
      }),
      authMode: input.publicAuth === undefined ? "cloudflare-access" : "artifactpass",
      ...(input.publicAuth === undefined ? {} : {
        googleClientId: input.publicAuth.googleClientId,
        googleClientSecretSha256: createHash("sha256")
          .update(input.publicAuth.googleClientSecret).digest("hex"),
        githubClientId: input.publicAuth.githubClientId,
        githubClientSecretSha256: createHash("sha256")
          .update(input.publicAuth.githubClientSecret).digest("hex"),
      }),
      ...(input.privateAccess === undefined ? {} : { privateAccess: input.privateAccess }),
      ...(input.productionExistingResources === true ? { productionExistingResources: true } : {}),
      ...(input.allowedExpirySeconds === undefined ? {} : { allowedExpirySeconds: input.allowedExpirySeconds }),
      ...(input.authorizationBinding === undefined ? {} : { authorizationBinding: input.authorizationBinding }),
    },
    bundleSha256: await deploymentSha256(dependencies.deploymentRoot),
    remote: {
      zone,
      workersSubdomain,
      domain: domains.find((candidate) => candidate.hostname === input.hostname) ?? null,
      database,
      databaseSchema,
      databaseMigrations,
      deploymentMetadata,
      bucket,
      lifecycle,
      r2Marker,
      worker: scripts.find((candidate) => candidate.id === serviceName) ?? null,
      organization,
      application: application ?? null,
      policy: policies.find((candidate) => candidate.name === "Artifact Share uploaders") ?? null,
      identityProviders,
    },
  };
};

export interface DeployDependencies {
  readonly client: CloudflareClient;
  readonly runner?: ProcessRunner;
  readonly deploymentRoot: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readinessTimeoutMilliseconds?: number;
}

// A newly attached Worker custom domain can exist at Cloudflare before the local
// resolver's negative DNS cache expires. Keep every request bounded, but allow
// two minutes for the first hostname verification before requiring repair.
const readinessRetryDelays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000] as const;

const fetchAfterDeploymentPropagation = async (
  fetchImplementation: typeof globalThis.fetch,
  request: string,
  init: RequestInit,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMilliseconds: number,
  isReady: (response: Response) => boolean | Promise<boolean> = (response) =>
    response.status !== 404 && response.status !== 429 && response.status < 500,
): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= readinessRetryDelays.length; attempt += 1) {
    try {
      const response = await fetchImplementation(request, {
        ...init,
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
      if (await isReady(response.clone())) return response;
      lastError = new Error(`Deployment route is not ready (${response.status})`);
    } catch (error) {
      lastError = error;
    }
    const delay = readinessRetryDelays[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastError;
};

const isArtifactPassUploadRedirect = (response: Response, baseUrl: string): boolean => {
  if (response.status !== 302) return false;
  const location = response.headers.get("location");
  if (location === null) return false;
  try {
    const signInRedirect = new URL(location, baseUrl);
    return signInRedirect.origin === baseUrl &&
      signInRedirect.pathname === "/auth/sign-in" &&
      signInRedirect.searchParams.get("return_to") === "/upload";
  } catch {
    return false;
  }
};

export const deployArtifactShare = async (
  input: DeployInput,
  dependencies: DeployDependencies,
): Promise<DeploymentResult> => {
  const plan = deploymentPlan(input);
  const serviceName = input.serviceName ?? "lordebuilds-artifacts-share";
  const baseUrl = `https://${input.hostname}`;
  const teamCommand = `pnpm dlx artifactpass --base-url ${baseUrl}`;
  if (input.dryRun && input.productionExistingResources !== true) {
    return { baseUrl, teamCommand, plan, changed: [] };
  }

  const runner = dependencies.runner ?? runProcess;
  const changed: string[] = [];
  const rollbackActions: { readonly resource: string; readonly run: () => Promise<void> }[] = [];
  const resourceIdentities: Record<string, string> = {};
  let approvedBindingDigest: string | undefined;
  let approvedRemoteLifecycle: unknown;
  const verified = await dependencies.client.verifyToken();
  if (verified.status !== "active") throw new Error("Cloudflare API token is not active");
  if (input.dryRun) {
    const binding = await approvalBinding(input, serviceName, dependencies);
    const remote = binding.remote as {
      readonly worker?: WorkerScript | null;
      readonly database?: Database | null;
      readonly bucket?: Bucket | null;
      readonly application?: AccessApplication | null;
    };
    return {
      baseUrl,
      teamCommand,
      plan,
      changed: [],
      resources: {
        worker_service: remote.worker?.id ?? "",
        d1_database_id: remote.database?.uuid ?? "",
        r2_bucket_name: remote.bucket?.name ?? "",
        access_application_id: remote.application?.id ?? "",
      },
    };
  }
  if (input.writeApprovalManifest !== undefined || input.approveManifest !== undefined) {
    const binding = await approvalBinding(input, serviceName, dependencies);
    if (input.writeApprovalManifest !== undefined) {
      const manifest: ApprovalManifest = {
        version: input.productionExistingResources === true ? 4 : input.deploymentId === undefined ? 2 : 3,
        generated_at: new Date().toISOString(),
        binding,
      };
      await writeFile(input.writeApprovalManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return {
        baseUrl,
        teamCommand,
        plan,
        changed: [],
        approvalManifest: input.writeApprovalManifest,
      };
    }
    const approved = JSON.parse(await readFile(input.approveManifest ?? "", "utf8")) as ApprovalManifest;
    const expectedVersion = input.productionExistingResources === true ? 4 : input.deploymentId === undefined ? 2 : 3;
    if (approved.version !== expectedVersion || JSON.stringify(approved.binding) !== JSON.stringify(binding)) {
      throw new Error("Hosted approval manifest no longer matches the deployment bundle or Cloudflare state");
    }
    approvedBindingDigest = createHash("sha256").update(JSON.stringify(approved.binding)).digest("hex");
    approvedRemoteLifecycle = (approved.binding.remote as { readonly lifecycle?: unknown } | null)?.lifecycle;
  }
  try {
  let privateAccess = input.privateAccess;
  if (privateAccess?.providerAction === "create-after-approval") {
    const createdProvider = await dependencies.client.request<{ readonly id: string; readonly type?: string }>(
      `/accounts/${input.accountId}/access/identity_providers`,
      {
        method: "POST",
        body: JSON.stringify({
          name: `ArtifactPass email code ${input.deploymentId?.slice(0, 8) ?? serviceName}`,
          type: "onetimepin",
          config: {},
        }),
      },
    );
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(createdProvider.id)) {
      throw new Error("Cloudflare created an invalid email verification provider");
    }
    privateAccess = {
      ...privateAccess,
      allowedIdpIds: [createdProvider.id],
      providerAction: "reuse",
      autoRedirectToIdentity: true,
    };
    resourceIdentities.identity_provider_id = createdProvider.id;
    changed.push("Email verification provider");
  }
  const workersSubdomain = await readWorkersSubdomain(input, dependencies);
  if (workersSubdomain === null) {
    if (input.productionExistingResources === true) {
      throw new Error("Production Workers account subdomain is missing");
    }
    await dependencies.client.request(`/accounts/${input.accountId}/workers/subdomain`, {
      method: "PUT",
      body: JSON.stringify({ subdomain: input.workersSubdomain }),
    });
    changed.push("Workers account subdomain");
  } else if (workersSubdomain.subdomain !== input.workersSubdomain) {
    throw new Error(`Workers account subdomain is already ${workersSubdomain.subdomain}`);
  }
  const zone = await dependencies.client.request<{ readonly name: string; readonly status: string }>(
    `/zones/${input.zoneId}`,
  );
  if (
    zone.status !== "active" ||
    (input.hostname !== zone.name && !input.hostname.endsWith(`.${zone.name}`))
  ) {
    throw new Error("Hostname must belong to the selected active Cloudflare zone");
  }
  const domains = await dependencies.client.request<readonly WorkerDomain[]>(
    `/accounts/${input.accountId}/workers/domains`,
  );
  const collision = domains.find((domain) => domain.hostname === input.hostname && domain.service !== serviceName);
  if (collision !== undefined) throw new Error(`Hostname is already attached to Worker ${collision.service}`);

  const databaseName = serviceName;
  const databases = await dependencies.client.request<readonly Database[]>(
    `/accounts/${input.accountId}/d1/database?name=${encodeURIComponent(databaseName)}`,
  );
  let database = databases.find((candidate) => candidate.name === databaseName);
  const databaseCreated = database === undefined;
  if (database === undefined) {
    if (input.productionExistingResources === true) throw new Error("Production D1 database is missing");
    database = await dependencies.client.request<Database>(`/accounts/${input.accountId}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: databaseName }),
    });
    changed.push("D1 database");
  }
  resourceIdentities.d1_database_id = database.uuid;

  const buckets = await dependencies.client.request<{ readonly buckets: readonly Bucket[] }>(
    `/accounts/${input.accountId}/r2/buckets`,
  );
  const bucketCreated = !buckets.buckets.some((bucket) => bucket.name === serviceName);
  if (bucketCreated) {
    if (input.productionExistingResources === true) throw new Error("Production R2 bucket is missing");
    await dependencies.client.request(`/accounts/${input.accountId}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: serviceName }),
    });
    changed.push("R2 bucket");
  }
  resourceIdentities.r2_bucket_name = serviceName;

  const applications = await dependencies.client.request<readonly AccessApplication[]>(
    `/accounts/${input.accountId}/access/apps`,
  );
  let application = applications.find((candidate) => candidate.name === serviceName);
  const organization = input.publicAuth !== undefined && application === undefined
    ? null
    : await dependencies.client.request<AccessOrganization>(
        `/accounts/${input.accountId}/access/organizations`,
      );
  const legacyAccessPolicies = input.publicAuth !== undefined && application !== undefined
    ? await dependencies.client.request<readonly AccessPolicy[]>(
        `/accounts/${input.accountId}/access/apps/${application.id}/policies`,
      )
    : [];
  if (input.publicAuth !== undefined && application !== undefined) {
    const actual = canonicalJson((application.destinations ?? []).map((destination) => ({
      type: destination.type,
      ...(destination.uri === undefined ? {} : { uri: destination.uri }),
    })));
    if (actual !== canonicalJson(expectedDestinations(input.hostname))) {
      throw new Error("Existing Access application has different protected paths and cannot be removed safely");
    }
  } else if (input.publicAuth === undefined && application === undefined) {
    application = await dependencies.client.request<AccessApplication>(
      `/accounts/${input.accountId}/access/apps`,
      {
        method: "POST",
        body: JSON.stringify({
          name: serviceName,
          type: "self_hosted",
          session_duration: "24h",
          destinations: expectedDestinations(input.hostname),
          ...(privateAccess === undefined ? {} : {
            allowed_idps: privateAccess.allowedIdpIds,
            auto_redirect_to_identity: privateAccess.autoRedirectToIdentity,
          }),
        }),
      },
    );
    resourceIdentities.access_application_id = application.id;
    changed.push("Access application");
  } else if (input.publicAuth === undefined) {
    if (application === undefined) throw new Error("Cloudflare Access application is unavailable");
    const actual = canonicalJson((application.destinations ?? []).map((destination) => ({
      type: destination.type,
      ...(destination.uri === undefined ? {} : { uri: destination.uri }),
    })));
    if (actual !== canonicalJson(expectedDestinations(input.hostname))) {
      throw new Error("Existing Access application has different protected paths");
    }
    if (privateAccess !== undefined) {
      const actualProviders = [...(application.allowed_idps ?? [])].sort();
      const expectedProviders = [...privateAccess.allowedIdpIds].sort();
      if (
        JSON.stringify(actualProviders) !== JSON.stringify(expectedProviders) ||
        application.auto_redirect_to_identity !== privateAccess.autoRedirectToIdentity
      ) {
        throw new Error("Existing Access application has incompatible identity-provider bindings");
      }
    }
  }
  if (input.publicAuth === undefined) {
    if (application === undefined) throw new Error("Cloudflare Access application is unavailable");
    if (organization === null) throw new Error("Cloudflare Access organization is unavailable");
    if (typeof application.aud !== "string" || application.aud.length === 0) {
      throw new Error("Cloudflare Access application did not return an audience tag");
    }
    resourceIdentities.access_application_id = application.id;
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(organization.auth_domain)) {
      throw new Error("Cloudflare Access organization returned an invalid team domain");
    }

    const policies = await dependencies.client.request<readonly AccessPolicy[]>(
      `/accounts/${input.accountId}/access/apps/${application.id}/policies`,
    );
    const expectedIncludes = identityIncludes(input.identities);
    const policy = policies.find((candidate) => candidate.name === "Artifact Share uploaders");
    if (policy === undefined) {
      const createdPolicy = await dependencies.client.request<{ readonly id?: string }>(
        `/accounts/${input.accountId}/access/apps/${application.id}/policies`,
        {
          method: "POST",
          body: JSON.stringify({
            name: "Artifact Share uploaders",
            decision: "allow",
            include: expectedIncludes,
          }),
        },
      );
      if (typeof createdPolicy.id === "string") resourceIdentities.access_policy_id = createdPolicy.id;
      changed.push("Access policy");
    } else if (
      policy.decision !== "allow" ||
      canonicalJson(policy.include ?? []) !== canonicalJson(expectedIncludes)
    ) {
      await dependencies.client.request(
        `/accounts/${input.accountId}/access/apps/${application.id}/policies/${policy.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: "Artifact Share uploaders",
            decision: "allow",
            include: expectedIncludes,
          }),
        },
      );
      changed.push("Access policy");
    }
    if (policy !== undefined) resourceIdentities.access_policy_id = policy.id;
  }

  const template = JSON.parse(await readFile(resolve(dependencies.deploymentRoot, "wrangler-template.json"), "utf8"));
  template.name = serviceName;
  template.main = resolve(dependencies.deploymentRoot, "index.js");
  template.assets.directory = resolve(dependencies.deploymentRoot, "client");
  template.d1_databases[0] = {
    binding: "ARTIFACT_DB",
    database_name: databaseName,
    database_id: database.uuid,
    migrations_dir: resolve(dependencies.deploymentRoot, "migrations"),
  };
  template.r2_buckets[0] = { binding: "ARTIFACTS", bucket_name: serviceName };
  template.routes = [{ pattern: input.hostname, custom_domain: true }];
  template.workers_dev = false;
  template.preview_urls = false;
  if (input.publicAuth === undefined) {
    if (application === undefined) throw new Error("Cloudflare Access application is unavailable");
    if (organization === null) throw new Error("Cloudflare Access organization is unavailable");
    delete template.secrets;
    template.vars.HUMAN_AUTH_MODE = "cloudflare-access";
    template.vars.ACCESS_TEAM_DOMAIN = `https://${organization.auth_domain}`;
    template.vars.ACCESS_AUD = application.aud;
  } else {
    template.secrets = {
      required: ["GOOGLE_OAUTH_CLIENT_SECRET", "GITHUB_OAUTH_CLIENT_SECRET"],
    };
    delete template.vars.ACCESS_TEAM_DOMAIN;
    delete template.vars.ACCESS_AUD;
    template.vars.HUMAN_AUTH_MODE = "artifactpass";
    template.vars.GOOGLE_OAUTH_CLIENT_ID = input.publicAuth.googleClientId;
    template.vars.GITHUB_OAUTH_CLIENT_ID = input.publicAuth.githubClientId;
    template.vars.ALLOWED_EXPIRY_SECONDS = PUBLIC_EXPIRY_POLICY.allowed_seconds.join(",");
    template.vars.MAX_EXPIRY_SECONDS = String(PUBLIC_EXPIRY_POLICY.maximum_seconds);
  }
  if (input.pdfKeyId !== undefined && input.pdfPublicKey !== undefined) {
    template.vars.PDF_PROVENANCE_KEY_ID = input.pdfKeyId;
    template.vars.PDF_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [input.pdfKeyId]: input.pdfPublicKey });
    template.vars.PDF_PROVENANCE_RENDERERS = "artifact-share-qualified-pdf@1";
  } else {
    delete template.vars.PDF_PROVENANCE_KEY_ID;
    delete template.vars.PDF_PROVENANCE_PUBLIC_KEYS;
    delete template.vars.PDF_PROVENANCE_RENDERERS;
  }
  if (input.deploymentId !== undefined) {
    template.vars.ARTIFACTPASS_DEPLOYMENT_ID = input.deploymentId;
    if (approvedBindingDigest !== undefined) {
      template.vars.ARTIFACTPASS_DEPLOYMENT_MANIFEST_DIGEST = approvedBindingDigest;
    }
  }
  if (input.publicAuth === undefined && input.allowedExpirySeconds !== undefined) {
    template.vars.ALLOWED_EXPIRY_SECONDS = input.allowedExpirySeconds.join(",");
    template.vars.MAX_EXPIRY_SECONDS = String(input.allowedExpirySeconds.at(-1));
  }
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-deploy-"));
  const configurationPath = resolve(temporaryRoot, "wrangler.json");
  const secretsPath = resolve(temporaryRoot, "secrets.json");
  try {
    await writeFile(configurationPath, JSON.stringify(template), { mode: 0o600 });
    const lifecycleMaximum = input.publicAuth === undefined
      ? input.allowedExpirySeconds?.at(-1)
      : PUBLIC_EXPIRY_POLICY.maximum_seconds;
    const lifecyclePath = lifecycleMaximum === undefined
      ? resolve(dependencies.deploymentRoot, "storage-lifecycle.json")
      : resolve(temporaryRoot, "storage-lifecycle.json");
    if (lifecycleMaximum !== undefined) {
      await writeFile(
        lifecyclePath,
        JSON.stringify(storageLifecycleForMaximumExpiry(lifecycleMaximum)),
        { mode: 0o600 },
      );
    }
    const commandEnvironment = { CLOUDFLARE_ACCOUNT_ID: input.accountId };
    await runner("wrangler", [
      "d1", "migrations", "apply", databaseName, "--remote", "--config", configurationPath,
    ], { env: commandEnvironment });
    if (input.deploymentId !== undefined && approvedBindingDigest !== undefined && databaseCreated) {
      const timestamp = Math.floor(Date.now() / 1000);
      const sql = [
        "INSERT INTO deployment_metadata",
        "(deployment_id, manifest_digest, account_id, zone_id, hostname, service_name, created_at, updated_at)",
        `VALUES ('${input.deploymentId}', '${approvedBindingDigest}', '${input.accountId}', '${input.zoneId}', '${input.hostname}', '${serviceName}', ${timestamp}, ${timestamp});`,
      ].join(" ");
      await runner("wrangler", [
        "d1", "execute", databaseName, "--remote", "--config", configurationPath, "--command", sql,
      ], { env: commandEnvironment });
      changed.push("D1 ownership marker");
    }
    await runner("wrangler", [
      "r2", "bucket", "lifecycle", "set", serviceName,
      "--file", lifecyclePath, "--force",
    ], { env: commandEnvironment });
    const desiredLifecycle = lifecycleMaximum === undefined
      ? JSON.parse(await readFile(lifecyclePath, "utf8")) as unknown
      : storageLifecycleForMaximumExpiry(lifecycleMaximum);
    if (
      input.approveManifest !== undefined &&
      approvedRemoteLifecycle !== undefined &&
      canonicalCloudflareValue(approvedRemoteLifecycle) !== canonicalCloudflareValue(desiredLifecycle)
    ) {
      changed.push("R2 lifecycle");
      rollbackActions.push({
        resource: "R2 lifecycle",
        run: async () => {
          await dependencies.client.request(
            `/accounts/${input.accountId}/r2/buckets/${encodeURIComponent(serviceName)}/lifecycle`,
            { method: "PUT", body: JSON.stringify(approvedRemoteLifecycle) },
          );
        },
      });
    }
    if (input.deploymentId !== undefined && approvedBindingDigest !== undefined && bucketCreated) {
      const marker: DeploymentMarker = {
        version: 1,
        deployment_id: input.deploymentId,
        bucket_name: serviceName,
        creation_operation_id: randomUUID(),
        manifest_digest: approvedBindingDigest,
      };
      const markerPath = resolve(temporaryRoot, "deployment-marker.json");
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      await runner("wrangler", [
        "r2", "object", "put", `${serviceName}/.artifactpass/deployment.json`,
        "--remote", "--file", markerPath,
      ], { env: commandEnvironment });
      changed.push("R2 ownership marker");
      resourceIdentities.r2_marker_operation_id = marker.creation_operation_id;
    }
    if (input.publicAuth !== undefined) {
      await writeFile(secretsPath, JSON.stringify({
          GOOGLE_OAUTH_CLIENT_SECRET: input.publicAuth.googleClientSecret,
          GITHUB_OAUTH_CLIENT_SECRET: input.publicAuth.githubClientSecret,
        }), { mode: 0o600 });
    }
    await runner("wrangler", [
      "deploy", "--config", configurationPath, "--strict",
      ...(input.publicAuth === undefined ? [] : ["--secrets-file", secretsPath]),
    ], { env: commandEnvironment });
    changed.push("Worker deployment");
    resourceIdentities.worker_service = serviceName;
  } finally {
    await rm(temporaryRoot, { recursive: true });
  }

  const fetchImplementation = dependencies.fetch ?? fetchCloudflareDeploymentRoute;
  const sleep = dependencies.sleep ?? (async (milliseconds: number) =>
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const readinessTimeoutMilliseconds = dependencies.readinessTimeoutMilliseconds ?? 10_000;
  await fetchAfterDeploymentPropagation(
    fetchImplementation,
    `${baseUrl}/health`,
    { redirect: "error" },
    sleep,
    readinessTimeoutMilliseconds,
    async (candidate) => {
      if (!candidate.ok) return false;
      const candidateHealth = await candidate.json().catch(() => null) as {
        readonly service?: string;
        readonly status?: string;
        readonly human_auth_mode?: string;
        readonly authentication_configured?: boolean;
      } | null;
      if (candidateHealth?.service !== "lordebuilds.artifacts.share" || candidateHealth.status !== "ok") {
        return false;
      }
      return input.publicAuth === undefined || (
        candidateHealth.human_auth_mode === "artifactpass" &&
        candidateHealth.authentication_configured === true
      );
    },
  );
  if (input.publicAuth !== undefined) {
    const signIn = await fetchAfterDeploymentPropagation(
      fetchImplementation,
      `${baseUrl}/auth/sign-in?return_to=%2Fupload`,
      { redirect: "manual" },
      sleep,
      readinessTimeoutMilliseconds,
    );
    if (!signIn.ok || !(await signIn.text()).includes("Continue with Google")) {
      throw new Error(`ArtifactPass sign-in check failed (${signIn.status})`);
    }
    for (const provider of ["google", "github"] as const) {
      const login = await fetchAfterDeploymentPropagation(
        fetchImplementation,
        `${baseUrl}/auth/login/${provider}?return_to=%2Fupload`,
        { redirect: "manual" },
        sleep,
        readinessTimeoutMilliseconds,
      );
      const location = login.headers.get("location");
      const expectedOrigin = provider === "google" ? "https://accounts.google.com" : "https://github.com";
      if (login.status !== 302 || location === null || new URL(location).origin !== expectedOrigin) {
        throw new Error(`ArtifactPass ${provider} authentication check failed (${login.status})`);
      }
    }
    if (input.productionExistingResources === true) {
      if (organization === null) throw new Error("Cloudflare Access organization is unavailable");
      const containedUpload = await fetchAfterDeploymentPropagation(
        fetchImplementation,
        `${baseUrl}/upload`,
        { redirect: "manual" },
        sleep,
        readinessTimeoutMilliseconds,
      );
      const location = containedUpload.headers.get("location");
      const accessHostname = new URL(`https://${organization.auth_domain}`).hostname;
      if (
        ![302, 303, 307, 401, 403].includes(containedUpload.status) ||
        (location !== null && new URL(location, baseUrl).hostname !== accessHostname)
      ) {
        throw new Error(`Cloudflare Access did not retain the production upload boundary (${containedUpload.status})`);
      }
      return {
        baseUrl,
        teamCommand,
        plan,
        changed,
        ...(Object.keys(resourceIdentities).length === 0 ? {} : { resources: resourceIdentities }),
        verification: {
          health: "passed",
          protectedUpload: "passed",
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    let removedLegacyAccess = false;
    if (application !== undefined) {
      await dependencies.client.request(
        `/accounts/${input.accountId}/access/apps/${application.id}`,
        { method: "DELETE" },
      );
      removedLegacyAccess = true;
      changed.push("Access application removal");
    }
    try {
      await fetchAfterDeploymentPropagation(
        fetchImplementation,
        `${baseUrl}/upload`,
        { redirect: "manual" },
        sleep,
        readinessTimeoutMilliseconds,
        (candidate) => isArtifactPassUploadRedirect(candidate, baseUrl),
      );
    } catch (error) {
      if (removedLegacyAccess) {
        try {
          const restoredApplication = await restoreLegacyAccess(
            input,
            serviceName,
            legacyAccessPolicies,
            dependencies,
          );
          if (
            typeof restoredApplication.aud !== "string" ||
            restoredApplication.aud.length === 0 ||
            organization === null ||
            !/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(organization.auth_domain)
          ) {
            throw new Error("Restored Cloudflare Access configuration is incomplete");
          }
          const rollbackTemplate = structuredClone(template);
          delete rollbackTemplate.secrets;
          rollbackTemplate.vars.HUMAN_AUTH_MODE = "cloudflare-access";
          rollbackTemplate.vars.ACCESS_TEAM_DOMAIN = `https://${organization.auth_domain}`;
          rollbackTemplate.vars.ACCESS_AUD = restoredApplication.aud;
          delete rollbackTemplate.vars.GOOGLE_OAUTH_CLIENT_ID;
          delete rollbackTemplate.vars.GITHUB_OAUTH_CLIENT_ID;
          const rollbackRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-rollback-"));
          try {
            const rollbackConfigurationPath = resolve(rollbackRoot, "wrangler.json");
            await writeFile(rollbackConfigurationPath, JSON.stringify(rollbackTemplate), { mode: 0o600 });
            await runner("wrangler", ["deploy", "--config", rollbackConfigurationPath, "--strict"], {
              env: { CLOUDFLARE_ACCOUNT_ID: input.accountId },
            });
          } finally {
            await rm(rollbackRoot, { recursive: true });
          }
          await fetchAfterDeploymentPropagation(
            fetchImplementation,
            `${baseUrl}/upload`,
            { redirect: "manual" },
            sleep,
            readinessTimeoutMilliseconds,
            (candidate) => [302, 303, 307, 401, 403].includes(candidate.status),
          );
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "ArtifactPass upload verification failed and the legacy Access gate could not be restored",
          );
        }
      }
      throw new Error("ArtifactPass did not protect the upload route after deployment propagation", {
        cause: error,
      });
    }
    return {
      baseUrl,
      teamCommand,
      plan,
      changed,
      ...(Object.keys(resourceIdentities).length === 0 ? {} : { resources: resourceIdentities }),
      verification: {
        health: "passed",
        protectedUpload: "passed",
        verifiedAt: new Date().toISOString(),
      },
    };
  }
  const protectedUpload = await fetchAfterDeploymentPropagation(
    fetchImplementation,
    `${baseUrl}/upload`,
    { redirect: "manual" },
    sleep,
    readinessTimeoutMilliseconds,
  );
  if (![302, 303, 307, 401, 403].includes(protectedUpload.status)) {
    throw new Error(`Cloudflare Access did not protect the upload route (${protectedUpload.status})`);
  }
  return {
    baseUrl,
    teamCommand,
    plan,
    changed,
    ...(Object.keys(resourceIdentities).length === 0 ? {} : { resources: resourceIdentities }),
    verification: {
      health: "passed",
      protectedUpload: "passed",
      verifiedAt: new Date().toISOString(),
    },
  };
  } catch (error) {
    if (changed.length === 0 && Object.keys(resourceIdentities).length === 0) throw error;
    const rolledBack: string[] = [];
    const rollbackFailures: string[] = [];
    for (const action of [...rollbackActions].reverse()) {
      try {
        await action.run();
        rolledBack.push(action.resource);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${action.resource}: ${rollbackError instanceof Error ? rollbackError.message : "rollback failed"}`,
        );
      }
    }
    throw new DeploymentMutationError(
      error instanceof Error ? error.message : "Cloudflare deployment failed after mutation started",
      [...changed],
      { ...resourceIdentities },
      error,
      rolledBack,
      rollbackFailures,
    );
  }
};

export const describeCloudflareFailure = (error: unknown): string => {
  if (error instanceof CloudflareApiError && error.status === 403) {
    return "Cloudflare denied a required operation. Verify Workers Scripts Write, D1 Write, Workers R2 Storage Write, Workers Routes Write, Zone Read, Access: Apps and Policies Write, and Access: Organizations, Identity Providers, and Groups Read on the selected account and zone.";
  }
  return error instanceof Error ? error.message : "Cloudflare deployment failed";
};
