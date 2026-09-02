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

interface D1QueryResult {
  readonly results?: readonly { readonly count?: number }[];
}

interface R2Object {
  readonly key?: string;
}

interface R2ObjectResult {
  readonly objects?: readonly R2Object[];
  readonly truncated?: boolean;
  readonly cursor?: string;
}

export const privateArtifactStorageEvidence = (options: {
  readonly artifactId: string;
  readonly rowCount: number;
  readonly objects: readonly R2Object[];
  readonly expectation: "present" | "absent";
  readonly truncated?: boolean;
  readonly cursor?: string;
}) => {
  if (!Number.isInteger(options.rowCount) || options.rowCount < 0 || options.rowCount > 1) {
    throw new Error("Cloudflare returned an invalid private artifact row count");
  }
  if (options.truncated === true || (options.cursor?.length ?? 0) > 0) {
    throw new Error("Cloudflare returned a truncated private artifact object listing");
  }
  const prefix = `artifacts/${options.artifactId}/`;
  if (options.objects.some((object) => object.key?.startsWith(prefix) !== true)) {
    throw new Error("Cloudflare ignored the private artifact object prefix");
  }
  const objectCount = options.objects.length;
  const matchesExpectation = options.expectation === "present"
    ? options.rowCount === 1 && objectCount > 0
    : options.rowCount === 0 && objectCount === 0;
  if (!matchesExpectation) {
    throw new Error(`Private artifact storage did not match the expected ${options.expectation} state`);
  }
  return {
    event: "private-artifact-storage-inspected",
    artifact_reference: createHash("sha256").update(options.artifactId).digest("hex").slice(0, 16),
    expected_state: options.expectation,
    metadata_row_present: options.rowCount === 1,
    stored_object_count: objectCount,
  } as const;
};

const boundedFetch: typeof fetch = async (input, init = {}) => await fetch(input, {
  ...init,
  signal: AbortSignal.timeout(30_000),
});

export const runPrivateArtifactStorageInspection = async (): Promise<void> => {
  const selector = valueAfter("--resume");
  const artifactId = valueAfter("--artifact-id");
  const expectation = valueAfter("--expect");
  if (expectation !== "present" && expectation !== "absent") {
    throw new Error("--expect must be present or absent");
  }
  const state = await resolvePrivateDeploymentState(privateDeploymentStateRoot(), selector);
  const accountId = state.cloudflare?.account_id;
  const databaseId = state.resources?.d1_database_id;
  const bucketName = state.resources?.r2_bucket_name;
  if (accountId === undefined || databaseId === undefined || bucketName === undefined) {
    throw new Error("The private deployment state is missing its Cloudflare storage bindings");
  }
  const accessToken = await privateDeploymentAccessTokenForInspection(state);
  if (accessToken === null) throw new Error("An active private deployment authorization is required");
  const client = new CloudflareClient({ token: accessToken, fetch: boundedFetch });
  const queryResults = await client.request<readonly D1QueryResult[]>(
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT COUNT(*) AS count FROM artifacts WHERE id = ?",
        params: [artifactId],
      }),
    },
  );
  const rowCount = Number(queryResults[0]?.results?.[0]?.count ?? Number.NaN);
  const prefix = `artifacts/${artifactId}/`;
  const objectResult = await client.request<readonly R2Object[] | R2ObjectResult>(
    `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?` +
      new URLSearchParams({ prefix, per_page: "1000" }).toString(),
  );
  const result: R2ObjectResult = Array.isArray(objectResult)
    ? { objects: [...objectResult] }
    : objectResult as R2ObjectResult;
  const evidence = privateArtifactStorageEvidence({
    artifactId,
    rowCount,
    objects: result.objects ?? [],
    expectation,
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrivateArtifactStorageInspection();
}
