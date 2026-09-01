import { CloudflareApiError, type CloudflareClient } from "./client";

const cloudflareId = /^[a-f0-9]{32}$/u;

export interface CloudflareAccountSummary {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareZoneSummary {
  readonly id: string;
  readonly account_id: string;
  readonly name: string;
  readonly status: "active" | "pending" | "initializing" | "moved";
  readonly name_servers: readonly string[];
}

export type CloudflarePrerequisiteStatus =
  | { readonly status: "ready"; readonly evidence: Readonly<Record<string, unknown>> }
  | { readonly status: "pending"; readonly message: string }
  | { readonly status: "permission-denied"; readonly message: string };

export interface CloudflarePrerequisiteSnapshot {
  readonly d1: CloudflarePrerequisiteStatus;
  readonly r2: CloudflarePrerequisiteStatus;
  readonly zeroTrust: CloudflarePrerequisiteStatus;
  readonly workersSubdomain: CloudflarePrerequisiteStatus;
}

const record = (value: unknown, message: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, message: string, maximum = 253): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(message);
  return value;
};

const validId = (value: unknown, message: string): string => {
  const id = requiredString(value, message, 64);
  if (!cloudflareId.test(id)) throw new Error(message);
  return id;
};

const boundedArray = (value: unknown, message: string): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > 100) throw new Error(message);
  return value;
};

export const listCloudflareAccounts = async (
  client: CloudflareClient,
): Promise<readonly CloudflareAccountSummary[]> => {
  const result = await client.request<unknown>("/accounts?per_page=50");
  return boundedArray(result, "Cloudflare returned a malformed account list")
    .map((item) => {
      const candidate = record(item, "Cloudflare returned a malformed account");
      return {
        id: validId(candidate.id, "Cloudflare returned an invalid account ID"),
        name: requiredString(candidate.name, "Cloudflare returned an invalid account name", 128),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
};

export const listCloudflareZones = async (
  client: CloudflareClient,
  accountId: string,
): Promise<readonly CloudflareZoneSummary[]> => {
  if (!cloudflareId.test(accountId)) throw new Error("Choose a valid Cloudflare account");
  const result = await client.request<unknown>(`/zones?account.id=${accountId}&per_page=50`);
  return boundedArray(result, "Cloudflare returned a malformed zone list")
    .map((item) => {
      const candidate = record(item, "Cloudflare returned a malformed zone");
      const account = record(candidate.account, "Cloudflare returned a zone without its account");
      const status = requiredString(candidate.status, "Cloudflare returned an invalid zone status", 32);
      if (!new Set(["active", "pending", "initializing", "moved"]).has(status)) {
        throw new Error("Cloudflare returned an unknown zone status");
      }
      const nameServers = boundedArray(candidate.name_servers ?? [], "Cloudflare returned invalid nameservers")
        .map((value) => requiredString(value, "Cloudflare returned an invalid nameserver", 253));
      return {
        id: validId(candidate.id, "Cloudflare returned an invalid zone ID"),
        account_id: validId(account.id, "Cloudflare returned an invalid zone account ID"),
        name: requiredString(candidate.name, "Cloudflare returned an invalid zone name", 253).toLowerCase(),
        status: status as CloudflareZoneSummary["status"],
        name_servers: nameServers,
      };
    })
    .filter((zone) => zone.account_id === accountId)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
};

const permissionOrPending = (
  error: unknown,
  pendingMessage: string,
  permissionMessage: string,
): CloudflarePrerequisiteStatus => {
  if (error instanceof CloudflareApiError) {
    if (error.status === 401 || error.status === 403) {
      const looksLikeOnboarding = /not enabled|subscription|enable r2|zero trust organization|not found/iu.test(error.message);
      return looksLikeOnboarding
        ? { status: "pending", message: pendingMessage }
        : { status: "permission-denied", message: permissionMessage };
    }
    if (error.status === 404) return { status: "pending", message: pendingMessage };
    if (error.status === 429 || error.status >= 500) {
      return { status: "pending", message: `${pendingMessage} Cloudflare asked ArtifactPass to retry later (${error.status}).` };
    }
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { status: "pending", message: `${pendingMessage} The Cloudflare check timed out.` };
  }
  throw error;
};

export const inspectCloudflarePrerequisites = async (
  client: CloudflareClient,
  accountId: string,
): Promise<CloudflarePrerequisiteSnapshot> => {
  if (!cloudflareId.test(accountId)) throw new Error("Choose a valid Cloudflare account");
  const [d1, r2, zeroTrust, workersSubdomain] = await Promise.all([
    client.request<unknown>(`/accounts/${accountId}/d1/database?per_page=1`)
      .then((): CloudflarePrerequisiteStatus => ({ status: "ready", evidence: { accessible: true } }))
      .catch((error): CloudflarePrerequisiteStatus => permissionOrPending(
        error,
        "D1 is not active for this account yet.",
        "Cloudflare authorization cannot read D1 for this account.",
      )),
    client.request<unknown>(`/accounts/${accountId}/r2/buckets?per_page=1`)
      .then((value): CloudflarePrerequisiteStatus => {
        const candidate = record(value, "Cloudflare returned a malformed R2 response");
        boundedArray(candidate.buckets ?? [], "Cloudflare returned a malformed R2 bucket list");
        return { status: "ready", evidence: { accessible: true } };
      })
      .catch((error): CloudflarePrerequisiteStatus => permissionOrPending(
        error,
        "R2 first-time setup is not complete for this account.",
        "Cloudflare authorization cannot read R2 for this account.",
      )),
    client.request<unknown>(`/accounts/${accountId}/access/organizations`)
      .then((value): CloudflarePrerequisiteStatus => {
        const candidate = record(value, "Cloudflare returned a malformed Zero Trust organization");
        return {
          status: "ready",
          evidence: {
            auth_domain: requiredString(candidate.auth_domain, "Cloudflare Zero Trust has no team domain", 253),
          },
        };
      })
      .catch((error): CloudflarePrerequisiteStatus => permissionOrPending(
        error,
        "Cloudflare Zero Trust onboarding is not complete for this account.",
        "Cloudflare authorization cannot read the Zero Trust organization for this account.",
      )),
    client.request<unknown>(`/accounts/${accountId}/workers/subdomain`)
      .then((value): CloudflarePrerequisiteStatus => {
        const candidate = record(value, "Cloudflare returned a malformed Workers subdomain");
        return {
          status: "ready",
          evidence: {
            subdomain: requiredString(candidate.subdomain, "Cloudflare Workers has no account subdomain", 63),
          },
        };
      })
      .catch((error): CloudflarePrerequisiteStatus => permissionOrPending(
        error,
        "This Cloudflare account does not have a Workers subdomain yet.",
        "Cloudflare authorization cannot read the account Workers subdomain.",
      )),
  ]);
  return { d1, r2, zeroTrust, workersSubdomain };
};

export const suggestWorkersSubdomain = (accountName: string): string => {
  const normalized = accountName.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return `${normalized.length === 0 ? "artifactpass" : normalized}-artifacts`;
};

export const cloudflareDashboardUrls = (accountId: string): {
  readonly addDomain: string;
  readonly r2: string;
  readonly zeroTrust: string;
} => {
  if (!cloudflareId.test(accountId)) throw new Error("Choose a valid Cloudflare account");
  return {
    addDomain: `https://dash.cloudflare.com/${accountId}/domains/new`,
    r2: `https://dash.cloudflare.com/${accountId}/r2/overview`,
    zeroTrust: `https://one.dash.cloudflare.com/${accountId}/home`,
  };
};
