import { createHash } from "node:crypto";

import type { CloudflareClient } from "./client";

const providerIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const providerTypePattern = /^[a-z0-9_-]{1,64}$/u;

export interface CloudflareIdentityProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface PrivateAccessIdentityRule {
  readonly kind: "authenticated" | "domain" | "email";
  readonly value: string;
}

export interface PrivateIdentityPlan {
  readonly mode: "email-code" | "company-login";
  readonly providerIds: readonly string[];
  readonly providerAction: "reuse" | "create-after-approval";
  readonly autoRedirectToIdentity: boolean;
  readonly rules: readonly PrivateAccessIdentityRule[];
  readonly providerDisplayDigest: string;
}

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloudflare returned a malformed identity provider");
  }
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Cloudflare returned an invalid identity provider ${field}`);
  }
  return value;
};

const providerDisplayName = (name: unknown, type: string): string => {
  if (typeof name === "string" && name.length > 0 && name.length <= 128) return name;
  if (type === "onetimepin") return "Email verification code";
  return type.split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
};

export const listCloudflareIdentityProviders = async (
  client: CloudflareClient,
  accountId: string,
): Promise<readonly CloudflareIdentityProviderSummary[]> => {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error("Choose a valid Cloudflare account");
  const result = await client.request<unknown>(`/accounts/${accountId}/access/identity_providers`);
  if (!Array.isArray(result) || result.length > 100) throw new Error("Cloudflare returned a malformed identity provider list");
  return result.map((item) => {
    const candidate = record(item);
    const id = requiredString(candidate.id, "ID", 128);
    if (!providerIdPattern.test(id)) throw new Error("Cloudflare returned an invalid identity provider ID");
    const type = requiredString(candidate.type, "type", 64).toLowerCase();
    if (!providerTypePattern.test(type)) throw new Error("Cloudflare returned an invalid identity provider type");
    return {
      id,
      name: providerDisplayName(candidate.name, type),
      type,
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
};

export const identityProviderDisplayDigest = (
  providers: readonly CloudflareIdentityProviderSummary[],
): string => createHash("sha256")
  .update(JSON.stringify(providers.map(({ id, name, type }) => ({ id, name, type }))))
  .digest("hex");

export const cloudflareIdentityProviderUrl = (accountId: string): string => {
  if (!/^[a-f0-9]{32}$/u.test(accountId)) throw new Error("Choose a valid Cloudflare account");
  return `https://one.dash.cloudflare.com/${accountId}/settings/authentication`;
};

export const validatePrivateIdentityPlan = (plan: PrivateIdentityPlan): PrivateIdentityPlan => {
  if (plan.providerIds.length > 20 || !plan.providerIds.every((id) => providerIdPattern.test(id))) {
    throw new Error("Private Access identity provider selection is invalid");
  }
  if (new Set(plan.providerIds).size !== plan.providerIds.length) throw new Error("Identity provider IDs must be unique");
  if (plan.providerAction === "reuse" && plan.providerIds.length === 0) throw new Error("A reused identity provider requires an ID");
  if (plan.providerAction === "create-after-approval" && (plan.mode !== "email-code" || plan.providerIds.length !== 0)) {
    throw new Error("Only email verification code may plan a new identity provider");
  }
  if (plan.autoRedirectToIdentity !== (plan.providerIds.length === 1 || (plan.mode === "email-code" && plan.providerAction === "create-after-approval"))) {
    throw new Error("Direct identity redirect requires exactly one planned provider");
  }
  if (plan.rules.length === 0) throw new Error("At least one private publisher rule is required");
  if (plan.mode === "email-code" && plan.rules.some((rule) => rule.kind === "authenticated")) {
    throw new Error("Email verification code cannot allow every internet email address");
  }
  if (plan.mode === "company-login" && plan.rules.some((rule) => rule.kind !== "authenticated")) {
    throw new Error("Company login access is bound to its selected identity providers");
  }
  return plan;
};
