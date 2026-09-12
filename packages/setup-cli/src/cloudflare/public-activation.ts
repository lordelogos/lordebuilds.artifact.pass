import { readFile, writeFile } from "node:fs/promises";

import type { CloudflareClient } from "./client";

interface AccessApplication {
  readonly id: string;
  readonly name: string;
  readonly destinations?: readonly { readonly type: string; readonly uri?: string }[];
}

interface AccessPolicy {
  readonly id: string;
  readonly name: string;
  readonly decision?: string;
  readonly include?: readonly unknown[];
}

interface ActivationBinding {
  readonly accountId: string;
  readonly hostname: string;
  readonly serviceName: string;
  readonly accessApplication: AccessApplication;
  readonly policies: readonly AccessPolicy[];
}

interface ActivationManifest {
  readonly version: 1;
  readonly generated_at: string;
  readonly binding: ActivationBinding;
}

export interface PublicActivationInput {
  readonly accountId: string;
  readonly hostname: string;
  readonly serviceName?: string;
  readonly writeApprovalManifest?: string;
  readonly approveManifest?: string;
}

export interface PublicActivationResult {
  readonly baseUrl: string;
  readonly changed: readonly string[];
  readonly activationPolicyId?: string;
}

export interface PublicActivationDependencies {
  readonly client: CloudflareClient;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const activationPolicyName = "ArtifactPass temporary public activation";
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const identifier = /^[a-f0-9]{32}$/u;

const expectedDestinations = (hostname: string) => [
  { type: "public", uri: `${hostname}/upload*` },
  { type: "public", uri: `${hostname}/connect/approve*` },
];

const canonicalArray = (value: readonly unknown[]): string =>
  JSON.stringify([...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));

const readBinding = async (
  input: PublicActivationInput,
  dependencies: PublicActivationDependencies,
): Promise<ActivationBinding> => {
  const serviceName = input.serviceName ?? "lordebuilds-artifacts-share";
  const applications = await dependencies.client.request<readonly AccessApplication[]>(
    `/accounts/${input.accountId}/access/apps`,
  );
  const application = applications.find((candidate) => candidate.name === serviceName);
  if (
    application === undefined ||
    canonicalArray(application.destinations ?? []) !== canonicalArray(expectedDestinations(input.hostname))
  ) {
    throw new Error("The approved ArtifactPass Access application is unavailable or has different protected paths");
  }
  const policies = await dependencies.client.request<readonly AccessPolicy[]>(
    `/accounts/${input.accountId}/access/apps/${application.id}/policies`,
  );
  if (policies.some((policy) => policy.name === activationPolicyName || policy.decision === "bypass")) {
    throw new Error("ArtifactPass production access is already relaxed");
  }
  return {
    accountId: input.accountId,
    hostname: input.hostname,
    serviceName,
    accessApplication: application,
    policies: [...policies].sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const isArtifactPassUploadRedirect = (response: Response, baseUrl: string): boolean => {
  if (response.status !== 302) return false;
  const location = response.headers.get("location");
  if (location === null) return false;
  const redirect = new URL(location, baseUrl);
  return redirect.origin === baseUrl &&
    redirect.pathname === "/auth/sign-in" &&
    redirect.searchParams.get("return_to") === "/upload";
};

const verifyPublicUpload = async (
  baseUrl: string,
  dependencies: PublicActivationDependencies,
): Promise<void> => {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? (async (milliseconds: number) =>
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  let lastStatus = 0;
  for (const delay of [0, 1_000, 2_000, 4_000, 8_000] as const) {
    if (delay > 0) await sleep(delay);
    const response = await fetchImplementation(`${baseUrl}/upload`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = response.status;
    if (isArtifactPassUploadRedirect(response, baseUrl)) return;
  }
  throw new Error(`ArtifactPass public upload verification failed (${lastStatus})`);
};

export const activatePublicArtifactPass = async (
  input: PublicActivationInput,
  dependencies: PublicActivationDependencies,
): Promise<PublicActivationResult> => {
  if (!identifier.test(input.accountId)) throw new Error("Cloudflare account ID must be 32 lowercase hexadecimal characters");
  if (!hostnamePattern.test(input.hostname)) throw new Error("Choose a valid lowercase hostname");
  if ((input.writeApprovalManifest === undefined) === (input.approveManifest === undefined)) {
    throw new Error("Choose exactly one activation approval manifest operation");
  }
  const verified = await dependencies.client.verifyToken();
  if (verified.status !== "active") throw new Error("Cloudflare API token is not active");
  const binding = await readBinding(input, dependencies);
  if (input.writeApprovalManifest !== undefined) {
    const manifest: ActivationManifest = { version: 1, generated_at: new Date().toISOString(), binding };
    await writeFile(input.writeApprovalManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { baseUrl: `https://${input.hostname}`, changed: [] };
  }
  const approved = JSON.parse(await readFile(input.approveManifest ?? "", "utf8")) as ActivationManifest;
  if (approved.version !== 1 || JSON.stringify(approved.binding) !== JSON.stringify(binding)) {
    throw new Error("Public activation approval no longer matches Cloudflare Access state");
  }

  const created = await dependencies.client.request<{ readonly id: string }>(
    `/accounts/${input.accountId}/access/apps/${binding.accessApplication.id}/policies`,
    {
      method: "POST",
      body: JSON.stringify({
        name: activationPolicyName,
        decision: "bypass",
        include: [{ everyone: {} }],
      }),
    },
  );
  try {
    await verifyPublicUpload(`https://${input.hostname}`, dependencies);
  } catch (error) {
    try {
      await dependencies.client.request(
        `/accounts/${input.accountId}/access/apps/${binding.accessApplication.id}/policies/${created.id}`,
        { method: "DELETE" },
      );
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Public activation failed and Access containment could not be restored");
    }
    throw new Error("Public activation failed; Access containment was restored", { cause: error });
  }
  return {
    baseUrl: `https://${input.hostname}`,
    changed: ["Access bypass policy"],
    activationPolicyId: created.id,
  };
};
