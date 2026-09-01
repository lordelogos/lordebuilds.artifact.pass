import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { ProcessRunner } from "../process";
import { runProcess } from "../process";
import { CloudflareApiError, CloudflareClient } from "./client";
import { storageLifecycleForMaximumExpiry } from "./retention-policy";

export interface IdentityRule {
  readonly kind: "authenticated" | "email" | "domain";
  readonly value: string;
}

export interface PrivateAccessConfiguration {
  readonly identityMode: "email-code" | "company-login";
  readonly allowedIdpIds: readonly string[];
  readonly autoRedirectToIdentity: boolean;
}

export interface DeployInput {
  readonly accountId: string;
  readonly zoneId: string;
  readonly hostname: string;
  readonly identities: readonly IdentityRule[];
  readonly dryRun: boolean;
  readonly pdfKeyId: string;
  readonly pdfPublicKey: string;
  readonly workersSubdomain: string;
  readonly serviceName?: string;
  readonly writeApprovalManifest?: string;
  readonly approveManifest?: string;
  readonly publicAuth?: {
    readonly googleClientId: string;
    readonly googleClientSecret: string;
    readonly githubClientId: string;
    readonly githubClientSecret: string;
  };
  readonly privateAccess?: PrivateAccessConfiguration;
  readonly allowedExpirySeconds?: readonly number[];
}

export interface DeploymentResult {
  readonly baseUrl: string;
  readonly teamCommand: string;
  readonly plan: readonly string[];
  readonly changed: readonly string[];
  readonly approvalManifest?: string;
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

interface ApprovalManifest {
  readonly version: 2;
  readonly generated_at: string;
  readonly binding: {
    readonly input: {
      readonly accountId: string;
      readonly zoneId: string;
      readonly hostname: string;
      readonly identities: readonly IdentityRule[];
      readonly serviceName: string;
      readonly pdfKeyId: string;
      readonly pdfPublicKeySha256: string;
      readonly workersSubdomain: string;
      readonly authMode: "cloudflare-access" | "artifactpass";
      readonly googleClientId?: string;
      readonly googleClientSecretSha256?: string;
      readonly githubClientId?: string;
      readonly githubClientSecretSha256?: string;
      readonly privateAccess?: PrivateAccessConfiguration;
      readonly allowedExpirySeconds?: readonly number[];
    };
    readonly bundleSha256: string;
    readonly remote: unknown;
  };
}

const identifier = /^[a-f0-9]{32}$/u;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const workersSubdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const serviceNamePattern = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u;

export const deploymentPlan = (input: DeployInput): readonly string[] => {
  if (!identifier.test(input.accountId) || !identifier.test(input.zoneId)) {
    throw new Error("Cloudflare account and zone IDs must be 32 lowercase hexadecimal characters");
  }
  if (!hostnamePattern.test(input.hostname)) throw new Error("Choose a valid lowercase hostname");
  if (input.serviceName !== undefined && !serviceNamePattern.test(input.serviceName)) {
    throw new Error("Choose a valid lowercase Cloudflare service name");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(input.pdfKeyId)) throw new Error("Choose a valid PDF signing key ID");
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(input.pdfPublicKey)) {
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
  if (input.publicAuth !== undefined && input.allowedExpirySeconds !== undefined) {
    throw new Error("Public ArtifactPass expiry policy is fixed at 15, 30, and 60 minutes");
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
    if (
      input.privateAccess.allowedIdpIds.length === 0 ||
      input.privateAccess.allowedIdpIds.length > 20 ||
      new Set(input.privateAccess.allowedIdpIds).size !== input.privateAccess.allowedIdpIds.length ||
      !input.privateAccess.allowedIdpIds.every((id) => /^[A-Za-z0-9_-]{1,128}$/u.test(id))
    ) {
      throw new Error("Private Access requires one or more valid identity provider IDs");
    }
    if (input.privateAccess.autoRedirectToIdentity !== (input.privateAccess.allowedIdpIds.length === 1)) {
      throw new Error("Direct identity redirect requires exactly one provider");
    }
    if (input.privateAccess.identityMode === "email-code" && input.identities.some((identity) => identity.kind === "authenticated")) {
      throw new Error("Email verification code cannot allow every internet email address");
    }
    if (input.privateAccess.identityMode === "company-login" && input.identities.some((identity) => identity.kind !== "authenticated")) {
      throw new Error("Company login is restricted by its selected providers");
    }
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
      "reuse or create the private D1 database and R2 bucket",
      "prepare the public Worker configuration with Google and GitHub OAuth secrets",
      "apply D1 migrations and the R2 cleanup lifecycle",
      "deploy the Worker and verify ArtifactPass authentication before removing the old Access gate",
      "verify public sign-in, protected upload redirection, and health",
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

const approvalBinding = async (
  input: DeployInput,
  serviceName: string,
  dependencies: DeployDependencies,
): Promise<ApprovalManifest["binding"]> => {
  const [workersSubdomain, zone, domains, databases, buckets, applications] = await Promise.all([
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
  const [scripts, databaseSchema, lifecycle] = await Promise.all([
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
    bucket === null
      ? Promise.resolve(null)
      : dependencies.client.request<unknown>(
          `/accounts/${input.accountId}/r2/buckets/${encodeURIComponent(serviceName)}/lifecycle`,
        ),
  ]);
  return {
    input: {
      accountId: input.accountId,
      zoneId: input.zoneId,
      hostname: input.hostname,
      identities: input.identities,
      serviceName,
      pdfKeyId: input.pdfKeyId,
      pdfPublicKeySha256: createHash("sha256").update(input.pdfPublicKey).digest("hex"),
      workersSubdomain: input.workersSubdomain,
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
      ...(input.allowedExpirySeconds === undefined ? {} : { allowedExpirySeconds: input.allowedExpirySeconds }),
    },
    bundleSha256: await deploymentSha256(dependencies.deploymentRoot),
    remote: {
      zone,
      workersSubdomain,
      domain: domains.find((candidate) => candidate.hostname === input.hostname) ?? null,
      database,
      databaseSchema,
      bucket,
      lifecycle,
      worker: scripts.find((candidate) => candidate.id === serviceName) ?? null,
      organization,
      application: application ?? null,
      policy: policies.find((candidate) => candidate.name === "Artifact Share uploaders") ?? null,
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

const readinessRetryDelays = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

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
  if (input.dryRun) return { baseUrl, teamCommand, plan, changed: [] };

  const runner = dependencies.runner ?? runProcess;
  const changed: string[] = [];
  const verified = await dependencies.client.verifyToken();
  if (verified.status !== "active") throw new Error("Cloudflare API token is not active");
  if (input.writeApprovalManifest !== undefined || input.approveManifest !== undefined) {
    const binding = await approvalBinding(input, serviceName, dependencies);
    if (input.writeApprovalManifest !== undefined) {
      const manifest: ApprovalManifest = {
        version: 2,
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
    if (approved.version !== 2 || JSON.stringify(approved.binding) !== JSON.stringify(binding)) {
      throw new Error("Hosted approval manifest no longer matches the deployment bundle or Cloudflare state");
    }
  }
  const workersSubdomain = await readWorkersSubdomain(input, dependencies);
  if (workersSubdomain === null) {
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
  if (database === undefined) {
    database = await dependencies.client.request<Database>(`/accounts/${input.accountId}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: databaseName }),
    });
    changed.push("D1 database");
  }

  const buckets = await dependencies.client.request<{ readonly buckets: readonly Bucket[] }>(
    `/accounts/${input.accountId}/r2/buckets`,
  );
  if (!buckets.buckets.some((bucket) => bucket.name === serviceName)) {
    await dependencies.client.request(`/accounts/${input.accountId}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: serviceName }),
    });
    changed.push("R2 bucket");
  }

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
          ...(input.privateAccess === undefined ? {} : {
            allowed_idps: input.privateAccess.allowedIdpIds,
            auto_redirect_to_identity: input.privateAccess.autoRedirectToIdentity,
          }),
        }),
      },
    );
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
    if (input.privateAccess !== undefined) {
      const actualProviders = [...(application.allowed_idps ?? [])].sort();
      const expectedProviders = [...input.privateAccess.allowedIdpIds].sort();
      if (
        JSON.stringify(actualProviders) !== JSON.stringify(expectedProviders) ||
        application.auto_redirect_to_identity !== input.privateAccess.autoRedirectToIdentity
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
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(organization.auth_domain)) {
      throw new Error("Cloudflare Access organization returned an invalid team domain");
    }

    const policies = await dependencies.client.request<readonly AccessPolicy[]>(
      `/accounts/${input.accountId}/access/apps/${application.id}/policies`,
    );
    const expectedIncludes = identityIncludes(input.identities);
    const policy = policies.find((candidate) => candidate.name === "Artifact Share uploaders");
    if (policy === undefined) {
      await dependencies.client.request(
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
    template.vars.ALLOWED_EXPIRY_SECONDS = "900,1800,3600";
    template.vars.MAX_EXPIRY_SECONDS = "3600";
  }
  template.vars.PDF_PROVENANCE_KEY_ID = input.pdfKeyId;
  template.vars.PDF_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [input.pdfKeyId]: input.pdfPublicKey });
  template.vars.PDF_PROVENANCE_RENDERERS = "artifact-share-qualified-pdf@1";
  if (input.publicAuth === undefined && input.allowedExpirySeconds !== undefined) {
    template.vars.ALLOWED_EXPIRY_SECONDS = input.allowedExpirySeconds.join(",");
    template.vars.MAX_EXPIRY_SECONDS = String(input.allowedExpirySeconds.at(-1));
  }
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-deploy-"));
  const configurationPath = resolve(temporaryRoot, "wrangler.json");
  try {
    await writeFile(configurationPath, JSON.stringify(template), { mode: 0o600 });
    const lifecyclePath = input.allowedExpirySeconds === undefined
      ? resolve(dependencies.deploymentRoot, "storage-lifecycle.json")
      : resolve(temporaryRoot, "storage-lifecycle.json");
    if (input.allowedExpirySeconds !== undefined) {
      await writeFile(
        lifecyclePath,
        JSON.stringify(storageLifecycleForMaximumExpiry(input.allowedExpirySeconds.at(-1) as number)),
        { mode: 0o600 },
      );
    }
    const commandEnvironment = { CLOUDFLARE_ACCOUNT_ID: input.accountId };
    await runner("wrangler", [
      "d1", "migrations", "apply", databaseName, "--remote", "--config", configurationPath,
    ], { env: commandEnvironment });
    await runner("wrangler", [
      "r2", "bucket", "lifecycle", "set", serviceName,
      "--file", lifecyclePath, "--force",
    ], { env: commandEnvironment });
    if (input.publicAuth !== undefined) {
      await runner("wrangler", ["secret", "bulk", "--config", configurationPath], {
        env: commandEnvironment,
        input: JSON.stringify({
          GOOGLE_OAUTH_CLIENT_SECRET: input.publicAuth.googleClientSecret,
          GITHUB_OAUTH_CLIENT_SECRET: input.publicAuth.githubClientSecret,
        }),
      });
    }
    await runner("wrangler", ["deploy", "--config", configurationPath, "--strict"], { env: commandEnvironment });
    changed.push("Worker deployment");
  } finally {
    await rm(temporaryRoot, { recursive: true });
  }

  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
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
    return { baseUrl, teamCommand, plan, changed };
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
  return { baseUrl, teamCommand, plan, changed };
};

export const describeCloudflareFailure = (error: unknown): string => {
  if (error instanceof CloudflareApiError && error.status === 403) {
    return "Cloudflare denied a required operation. Verify Workers Scripts Write, D1 Write, Workers R2 Storage Write, Workers Routes Write, Zone Read, Access: Apps and Policies Write, and Access: Organizations, Identity Providers, and Groups Read on the selected account and zone.";
  }
  return error instanceof Error ? error.message : "Cloudflare deployment failed";
};
