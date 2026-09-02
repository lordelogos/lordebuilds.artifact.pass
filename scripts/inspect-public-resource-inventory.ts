import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  CloudflareClient,
  type CloudflarePage,
  type CloudflareResultInfo,
} from "../packages/setup-cli/src/cloudflare/client";
import { CLOUDFLARE_OAUTH_SCOPE_PROFILES } from "../packages/setup-cli/src/cloudflare/oauth";
import { privateDeploymentAccessTokenForInspection } from "../packages/setup-cli/src/private-deployment/deployment-authorization";
import {
  privateDeploymentStateRoot,
  resolvePrivateDeploymentState,
  type PrivateDeploymentState,
} from "../packages/setup-cli/src/private-deployment/deployment-state";

const valueAfter = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined) throw new Error(`Missing ${name}`);
  return value;
};

interface NamedResource {
  readonly id?: string;
  readonly uuid?: string;
  readonly name?: string;
  readonly domain?: string;
}

interface ListedResources {
  readonly buckets?: readonly NamedResource[];
  readonly result_info?: CloudflareResultInfo;
}

interface WorkerDomain {
  readonly hostname: string;
  readonly service: string;
}

interface DnsAnswer {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly data?: unknown;
}

const publicNames = new Set(["artifactpass", "lordebuilds-artifacts-share"]);
const publicHostnames = new Set(["artifactpass.com", "www.artifactpass.com"]);
const expectedCounts = { d1: 1, r2: 1, workers: 1, access: 1 } as const;
const selectNamed = (resources: readonly NamedResource[]): readonly NamedResource[] => resources
  .filter((resource) =>
    (typeof resource.id === "string" && publicNames.has(resource.id)) ||
    (typeof resource.name === "string" && publicNames.has(resource.name)) ||
    (typeof resource.domain === "string" && publicHostnames.has(resource.domain)),
  )
  .map(({ id, uuid, name, domain }) => ({
    ...(id === undefined ? {} : { id }),
    ...(uuid === undefined ? {} : { uuid }),
    ...(name === undefined ? {} : { name }),
    ...(domain === undefined ? {} : { domain }),
  }))
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

const selectedPublicResources = (resources: Parameters<typeof publicResourceIdentityEvidence>[0]) => ({
  d1: selectNamed(resources.databases),
  r2: selectNamed(resources.buckets),
  workers: selectNamed(resources.scripts),
  access: selectNamed(resources.accessApps),
});

export const publicResourceIdentityEvidence = (resources: {
  readonly databases: readonly NamedResource[];
  readonly buckets: readonly NamedResource[];
  readonly scripts: readonly NamedResource[];
  readonly accessApps: readonly NamedResource[];
}) => {
  const selected = selectedPublicResources(resources);
  const resourceCounts = Object.fromEntries(
    Object.entries(selected).map(([name, values]) => [name, values.length]),
  ) as Record<keyof typeof expectedCounts, number>;
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (resourceCounts[name as keyof typeof expectedCounts] !== expected) {
      throw new Error(`Expected ${expected} public ${name} resource but found ${resourceCounts[name as keyof typeof expectedCounts]}`);
    }
  }
  return {
    event: "public-resource-identities-inspected",
    identity_digest: createHash("sha256").update(JSON.stringify(selected)).digest("hex"),
    resource_counts: resourceCounts,
  } as const;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
};

export const publicResourceMutableEvidence = (input: {
  readonly identities: Parameters<typeof publicResourceIdentityEvidence>[0];
  readonly workerSettings: unknown;
  readonly workerDomains: readonly unknown[];
  readonly d1Schema: readonly unknown[];
  readonly r2Lifecycle: unknown;
  readonly r2Objects: readonly unknown[];
  readonly accessPolicies: readonly unknown[];
  readonly dnsRecords: readonly unknown[];
  readonly grantedScopes: readonly string[];
  readonly expectedScopes: readonly string[];
}) => {
  const identity = publicResourceIdentityEvidence(input.identities);
  const grantedScopes = [...input.grantedScopes].sort();
  const expectedScopes = [...input.expectedScopes].sort();
  if (grantedScopes.length === 0 || JSON.stringify(grantedScopes) !== JSON.stringify(expectedScopes)) {
    throw new Error("Private deployment authorization scopes do not match the approved profile");
  }
  const mutableSnapshot = canonical({
    identities: selectedPublicResources(input.identities),
    worker_settings: input.workerSettings,
    worker_domains: input.workerDomains,
    d1_schema: input.d1Schema,
    r2_lifecycle: input.r2Lifecycle,
    r2_objects: input.r2Objects,
    access_policies: input.accessPolicies,
    dns_records: input.dnsRecords,
  });
  return {
    event: "public-resource-mutable-state-inspected",
    identity_digest: identity.identity_digest,
    mutable_state_digest: createHash("sha256").update(JSON.stringify(mutableSnapshot)).digest("hex"),
    resource_counts: identity.resource_counts,
    oauth_client_mutation_scope_present: false,
  } as const;
};

export const assertCompletePage = <T extends readonly unknown[]>(
  name: string,
  page: CloudflarePage<T>,
  requestedPerPage: number,
  nestedInfo?: CloudflareResultInfo,
): T => {
  const information = nestedInfo ?? page.resultInfo;
  const pageNumber = information?.page ?? 1;
  const totalPages = information?.total_pages ?? 1;
  if (
    information?.is_truncated === true ||
    (information?.cursor?.length ?? 0) > 0 ||
    totalPages > pageNumber ||
    (information === undefined && page.result.length >= requestedPerPage)
  ) {
    throw new Error(`Cloudflare returned a truncated ${name} listing`);
  }
  return page.result;
};

const boundedFetch: typeof fetch = async (input, init = {}) => await fetch(input, {
  ...init,
  signal: AbortSignal.timeout(30_000),
});

const publicDnsAnswers = async (fetchImplementation: typeof fetch): Promise<readonly unknown[]> => {
  const recordTypes = ["A", "AAAA", "CNAME", "HTTPS"] as const;
  const queries = [...publicHostnames].flatMap((hostname) => recordTypes.map(async (type) => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetchImplementation(url, {
      headers: { Accept: "application/dns-json" },
      redirect: "error",
    });
    const body = await response.json().catch(() => null) as {
      readonly Status?: unknown;
      readonly Answer?: readonly DnsAnswer[];
    } | null;
    if (
      !response.ok ||
      (body?.Status !== 0 && body?.Status !== 3) ||
      (body.Answer !== undefined && !Array.isArray(body.Answer))
    ) {
      throw new Error(`Public DNS inspection failed for ${hostname} ${type}`);
    }
    return {
      query: { hostname, type, status: body.Status },
      answers: (body.Answer ?? []).map((answer) => ({
        name: answer.name,
        type: answer.type,
        data: answer.data,
      })),
    };
  }));
  return await Promise.all(queries);
};

export const capturePublicResourceMutableEvidence = async (
  state: PrivateDeploymentState,
  client: CloudflareClient,
  dnsFetch: typeof fetch = boundedFetch,
) => {
  const accountId = state.cloudflare?.account_id;
  if (accountId === undefined) {
    throw new Error("The private deployment state is missing its Cloudflare account binding");
  }
  const perPage = 1000;
  const [databasePage, bucketPage, scriptPage, accessPage] = await Promise.all([
    client.requestPage<readonly NamedResource[]>(`/accounts/${accountId}/d1/database?per_page=${perPage}`),
    client.requestPage<readonly NamedResource[] | ListedResources>(`/accounts/${accountId}/r2/buckets?per_page=${perPage}`),
    client.requestPage<readonly NamedResource[]>(`/accounts/${accountId}/workers/scripts?per_page=${perPage}`),
    client.requestPage<readonly NamedResource[]>(`/accounts/${accountId}/access/apps?per_page=${perPage}`),
  ]);
  const databases = assertCompletePage("D1 database", databasePage, perPage);
  const bucketResult = bucketPage.result;
  let buckets: readonly NamedResource[];
  if (Array.isArray(bucketResult)) {
    buckets = assertCompletePage("R2 bucket", bucketPage as CloudflarePage<readonly NamedResource[]>, perPage);
  } else {
    const listed = bucketResult as ListedResources;
    buckets = assertCompletePage(
        "R2 bucket",
        { result: listed.buckets ?? [], ...(bucketPage.resultInfo === undefined ? {} : { resultInfo: bucketPage.resultInfo }) },
        perPage,
        listed.result_info,
      );
  }
  const scripts = assertCompletePage("Worker", scriptPage, perPage);
  const accessApps = assertCompletePage("Access application", accessPage, perPage);
  const identities = {
    databases,
    buckets,
    scripts,
    accessApps,
  };
  const publicDatabase = selectNamed(databases)[0];
  const publicBucket = selectNamed(identities.buckets)[0];
  const publicWorker = selectNamed(scripts)[0];
  const publicAccess = selectNamed(accessApps)[0];
  if (
    publicDatabase?.uuid === undefined || publicBucket?.name === undefined ||
    publicWorker?.id === undefined || publicAccess?.id === undefined
  ) {
    throw new Error("The public ArtifactPass resource bindings are incomplete");
  }
  if (state.cloudflare?.zone_id === undefined) {
    throw new Error("The private deployment state is missing its Cloudflare zone binding");
  }
  const [workerSettings, workerDomainPage, d1Queries, r2Lifecycle, r2ObjectPage, accessPolicyPage, dnsRecords] = await Promise.all([
    client.request<unknown>(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(publicWorker.id)}/settings`),
    client.requestPage<readonly WorkerDomain[]>(`/accounts/${accountId}/workers/domains?per_page=${perPage}`),
    client.request<readonly { readonly results?: readonly unknown[] }[]>(
      `/accounts/${accountId}/d1/database/${publicDatabase.uuid}/query`,
      { method: "POST", body: JSON.stringify({ sql: "SELECT name, type, sql FROM sqlite_schema ORDER BY type, name" }) },
    ),
    client.request<unknown>(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(publicBucket.name)}/lifecycle`),
    client.requestPage<readonly unknown[]>(
      `/accounts/${accountId}/r2/buckets/${encodeURIComponent(publicBucket.name)}/objects?per_page=${perPage}`,
    ),
    client.requestPage<readonly unknown[]>(`/accounts/${accountId}/access/apps/${publicAccess.id}/policies?per_page=${perPage}`),
    publicDnsAnswers(dnsFetch),
  ]);
  const workerDomains = assertCompletePage("Worker domain", workerDomainPage, perPage)
    .filter((domain) => publicHostnames.has(domain.hostname));
  const r2Objects = assertCompletePage("public R2 object", r2ObjectPage, perPage);
  const accessPolicies = assertCompletePage("Access policy", accessPolicyPage, perPage);
  const authorizationEvidence = state.checkpoints["cloudflare-authorized"]?.evidence;
  const profile = authorizationEvidence?.profile;
  const grantedScopes = authorizationEvidence?.granted_scopes;
  if (
    (profile !== "companyLogin" && profile !== "emailCode") ||
    !Array.isArray(grantedScopes) || !grantedScopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("The private deployment state lacks a proven Cloudflare OAuth scope profile");
  }
  return publicResourceMutableEvidence({
    identities,
    workerSettings,
    workerDomains,
    d1Schema: d1Queries.flatMap((query) => query.results ?? []),
    r2Lifecycle,
    r2Objects,
    accessPolicies,
    dnsRecords,
    grantedScopes,
    expectedScopes: CLOUDFLARE_OAUTH_SCOPE_PROFILES[profile],
  });
};

export const runPublicResourceIdentityInspection = async (): Promise<void> => {
  const state = await resolvePrivateDeploymentState(privateDeploymentStateRoot(), valueAfter("--resume"));
  const accessToken = await privateDeploymentAccessTokenForInspection(state);
  if (accessToken === null) throw new Error("An active private deployment authorization is required");
  const client = new CloudflareClient({ token: accessToken, fetch: boundedFetch });
  const evidence = await capturePublicResourceMutableEvidence(state, client);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPublicResourceIdentityInspection();
}
