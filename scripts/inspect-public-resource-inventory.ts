import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { CloudflareClient } from "../packages/setup-cli/src/cloudflare/client";
import { privateDeploymentAccessTokenForInspection } from "../packages/setup-cli/src/private-deployment/deployment-authorization";
import {
  privateDeploymentStateRoot,
  resolvePrivateDeploymentState,
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

export const publicResourceIdentityEvidence = (resources: {
  readonly databases: readonly NamedResource[];
  readonly buckets: readonly NamedResource[];
  readonly scripts: readonly NamedResource[];
  readonly accessApps: readonly NamedResource[];
}) => {
  const selected = {
    d1: selectNamed(resources.databases),
    r2: selectNamed(resources.buckets),
    workers: selectNamed(resources.scripts),
    access: selectNamed(resources.accessApps),
  };
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

const boundedFetch: typeof fetch = async (input, init = {}) => await fetch(input, {
  ...init,
  signal: AbortSignal.timeout(30_000),
});

export const runPublicResourceIdentityInspection = async (): Promise<void> => {
  const state = await resolvePrivateDeploymentState(privateDeploymentStateRoot(), valueAfter("--resume"));
  const accountId = state.cloudflare?.account_id;
  if (accountId === undefined) {
    throw new Error("The private deployment state is missing its Cloudflare account binding");
  }
  const accessToken = await privateDeploymentAccessTokenForInspection(state);
  if (accessToken === null) throw new Error("An active private deployment authorization is required");
  const client = new CloudflareClient({ token: accessToken, fetch: boundedFetch });
  const [databases, bucketResult, scripts, accessApps] = await Promise.all([
    client.request<readonly NamedResource[]>(`/accounts/${accountId}/d1/database?per_page=1000`),
    client.request<readonly NamedResource[] | ListedResources>(`/accounts/${accountId}/r2/buckets?per_page=1000`),
    client.request<readonly NamedResource[]>(`/accounts/${accountId}/workers/scripts?per_page=1000`),
    client.request<readonly NamedResource[]>(`/accounts/${accountId}/access/apps?per_page=1000`),
  ]);
  const evidence = publicResourceIdentityEvidence({
    databases,
    buckets: Array.isArray(bucketResult)
      ? bucketResult
      : (bucketResult as ListedResources).buckets ?? [],
    scripts,
    accessApps,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPublicResourceIdentityInspection();
}
