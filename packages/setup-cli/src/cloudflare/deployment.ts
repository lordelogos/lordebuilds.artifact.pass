import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { ProcessRunner } from "../process";
import { runProcess } from "../process";
import { CloudflareApiError, CloudflareClient } from "./client";

export interface IdentityRule {
  readonly kind: "email" | "domain";
  readonly value: string;
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
}
interface AccessOrganization { readonly auth_domain: string }
interface WorkerDomain { readonly hostname: string; readonly service: string }
interface WorkerScript { readonly id: string; readonly modified_on?: string; readonly etag?: string }

interface ApprovalManifest {
  readonly version: 1;
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
    };
    readonly bundleSha256: string;
    readonly remote: unknown;
  };
}

const identifier = /^[a-f0-9]{32}$/u;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export const deploymentPlan = (input: DeployInput): readonly string[] => {
  if (!identifier.test(input.accountId) || !identifier.test(input.zoneId)) {
    throw new Error("Cloudflare account and zone IDs must be 32 lowercase hexadecimal characters");
  }
  if (!hostnamePattern.test(input.hostname)) throw new Error("Choose a valid lowercase hostname");
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(input.pdfKeyId)) throw new Error("Choose a valid PDF signing key ID");
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(input.pdfPublicKey)) {
    throw new Error("PDF public key must be one base64-encoded Ed25519 raw key");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(input.workersSubdomain)) {
    throw new Error("Choose a valid Workers account subdomain");
  }
  if (input.identities.length === 0) throw new Error("At least one allowed identity is required");
  for (const identity of input.identities) {
    const valid = identity.kind === "email"
      ? /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(identity.value)
      : hostnamePattern.test(`x.${identity.value}`);
    if (!valid) throw new Error(`Allowed ${identity.kind} is invalid`);
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
  identity.kind === "email"
    ? { email: { email: identity.value } }
    : { email_domain: { domain: identity.value } });

const canonicalJson = (value: readonly unknown[]): string =>
  JSON.stringify([...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));

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
  const [workersSubdomain, zone, domains, databases, buckets, organization, applications] = await Promise.all([
    readWorkersSubdomain(input, dependencies),
    dependencies.client.request<{ readonly name: string; readonly status: string }>(`/zones/${input.zoneId}`),
    dependencies.client.request<readonly WorkerDomain[]>(`/accounts/${input.accountId}/workers/domains`),
    dependencies.client.request<readonly Database[]>(
      `/accounts/${input.accountId}/d1/database?name=${encodeURIComponent(serviceName)}`,
    ),
    dependencies.client.request<{ readonly buckets: readonly Bucket[] }>(
      `/accounts/${input.accountId}/r2/buckets`,
    ),
    dependencies.client.request<AccessOrganization>(`/accounts/${input.accountId}/access/organizations`),
    dependencies.client.request<readonly AccessApplication[]>(`/accounts/${input.accountId}/access/apps`),
  ]);
  const application = applications.find((candidate) => candidate.name === serviceName);
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
}

export const deployArtifactShare = async (
  input: DeployInput,
  dependencies: DeployDependencies,
): Promise<DeploymentResult> => {
  const plan = deploymentPlan(input);
  const serviceName = input.serviceName ?? "lordebuilds-artifacts-share";
  const baseUrl = `https://${input.hostname}`;
  const teamCommand = `pnpm dlx artifactpass connect ${baseUrl}`;
  if (input.dryRun) return { baseUrl, teamCommand, plan, changed: [] };

  const runner = dependencies.runner ?? runProcess;
  const changed: string[] = [];
  const verified = await dependencies.client.verifyToken();
  if (verified.status !== "active") throw new Error("Cloudflare API token is not active");
  if (input.writeApprovalManifest !== undefined || input.approveManifest !== undefined) {
    const binding = await approvalBinding(input, serviceName, dependencies);
    if (input.writeApprovalManifest !== undefined) {
      const manifest: ApprovalManifest = {
        version: 1,
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
    if (approved.version !== 1 || JSON.stringify(approved.binding) !== JSON.stringify(binding)) {
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

  const organization = await dependencies.client.request<AccessOrganization>(
    `/accounts/${input.accountId}/access/organizations`,
  );
  const applications = await dependencies.client.request<readonly AccessApplication[]>(
    `/accounts/${input.accountId}/access/apps`,
  );
  let application = applications.find((candidate) => candidate.name === serviceName);
  if (application === undefined) {
    application = await dependencies.client.request<AccessApplication>(
      `/accounts/${input.accountId}/access/apps`,
      {
        method: "POST",
        body: JSON.stringify({
          name: serviceName,
          type: "self_hosted",
          session_duration: "24h",
          destinations: expectedDestinations(input.hostname),
        }),
      },
    );
    changed.push("Access application");
  } else {
    const actual = canonicalJson((application.destinations ?? []).map((destination) => ({
      type: destination.type,
      ...(destination.uri === undefined ? {} : { uri: destination.uri }),
    })));
    if (actual !== canonicalJson(expectedDestinations(input.hostname))) {
      throw new Error("Existing Access application has different protected paths");
    }
  }
  if (typeof application.aud !== "string" || application.aud.length === 0) {
    throw new Error("Cloudflare Access application did not return an audience tag");
  }
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(organization.auth_domain)) {
    throw new Error("Cloudflare Access organization returned an invalid team domain");
  }

  const policies = await dependencies.client.request<readonly {
    readonly id: string;
    readonly name: string;
    readonly decision?: string;
    readonly include?: readonly unknown[];
  }[]>(
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
  template.vars.ACCESS_TEAM_DOMAIN = `https://${organization.auth_domain}`;
  template.vars.ACCESS_AUD = application.aud;
  template.vars.PDF_PROVENANCE_KEY_ID = input.pdfKeyId;
  template.vars.PDF_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [input.pdfKeyId]: input.pdfPublicKey });
  template.vars.PDF_PROVENANCE_RENDERERS = "artifact-share-qualified-pdf@1";
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-deploy-"));
  const configurationPath = resolve(temporaryRoot, "wrangler.json");
  try {
    await writeFile(configurationPath, JSON.stringify(template), { mode: 0o600 });
    const commandEnvironment = { CLOUDFLARE_ACCOUNT_ID: input.accountId };
    await runner("wrangler", [
      "d1", "migrations", "apply", databaseName, "--remote", "--config", configurationPath,
    ], { env: commandEnvironment });
    await runner("wrangler", [
      "r2", "bucket", "lifecycle", "set", serviceName,
      "--file", resolve(dependencies.deploymentRoot, "storage-lifecycle.json"), "--force",
    ], { env: commandEnvironment });
    await runner("wrangler", ["deploy", "--config", configurationPath, "--strict"], { env: commandEnvironment });
    changed.push("Worker deployment");
  } finally {
    await rm(temporaryRoot, { recursive: true });
  }

  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(`${baseUrl}/health`, { redirect: "error" });
  const health = await response.clone().json().catch(() => null) as {
    readonly service?: string;
    readonly status?: string;
  } | null;
  if (!response.ok || health?.service !== "lordebuilds.artifacts.share" || health.status !== "ok") {
    throw new Error(`Deployment health check failed (${response.status})`);
  }
  const protectedUpload = await fetchImplementation(`${baseUrl}/upload`, { redirect: "manual" });
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
