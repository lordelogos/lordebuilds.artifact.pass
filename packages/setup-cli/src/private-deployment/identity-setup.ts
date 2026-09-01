import {
  cloudflareIdentityProviderUrl,
  identityProviderDisplayDigest,
  listCloudflareIdentityProviders,
  validatePrivateIdentityPlan,
  type CloudflareIdentityProviderSummary,
  type PrivateAccessIdentityRule,
  type PrivateIdentityPlan,
} from "../cloudflare/identity";
import type { CloudflareClient } from "../cloudflare/client";
import { runBrowserHandoff, type BrowserHandoffPrompt } from "./browser-handoff";
import { provePrivateDeploymentCheckpoint, type PrivateDeploymentState } from "./deployment-state";

export interface PrivateIdentitySetupDependencies {
  readonly client: CloudflareClient;
  readonly prompt: BrowserHandoffPrompt;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly copyLink?: (url: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface PrivateIdentitySetupResult {
  readonly status: "ready" | "saved";
  readonly state: PrivateDeploymentState;
  readonly message: string;
  readonly plan?: PrivateIdentityPlan;
}

const askChoice = async (prompt: BrowserHandoffPrompt, question: string, options: readonly string[]): Promise<number> => {
  for (;;) {
    const answer = await prompt.question(`${question}\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n> `);
    const selection = Number.parseInt(answer.trim(), 10);
    if (Number.isInteger(selection) && selection >= 1 && selection <= options.length) return selection - 1;
    prompt.write(`Choose a number from 1 to ${options.length}.\n`);
  }
};

const askMultiple = async (
  prompt: BrowserHandoffPrompt,
  question: string,
  providers: readonly CloudflareIdentityProviderSummary[],
): Promise<readonly CloudflareIdentityProviderSummary[]> => {
  for (;;) {
    const answer = await prompt.question(`${question}\n${providers.map((provider, index) => `${index + 1}. ${provider.name} (${provider.type})`).join("\n")}\nEnter one or more numbers separated by commas:\n> `);
    const indexes = [...new Set(answer.split(",").map((value) => Number.parseInt(value.trim(), 10) - 1))];
    if (indexes.length > 0 && indexes.every((index) => Number.isInteger(index) && providers[index] !== undefined)) {
      return indexes.map((index) => providers[index] as CloudflareIdentityProviderSummary);
    }
    prompt.write(`Choose one or more numbers from 1 to ${providers.length}.\n`);
  }
};

const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

const storedIdentityRules = (state: PrivateDeploymentState): readonly PrivateAccessIdentityRule[] | null => {
  if (state.checkpoints["identity-ready"] === undefined) return null;
  const encoded = state.resources?.access_identity_rules;
  if (encoded === undefined) return null;
  try {
    const value = JSON.parse(encoded) as unknown;
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) =>
      item !== null && typeof item === "object" && !Array.isArray(item) &&
      ((item as { kind?: unknown }).kind === "authenticated" ||
        (item as { kind?: unknown }).kind === "domain" ||
        (item as { kind?: unknown }).kind === "email") &&
      typeof (item as { value?: unknown }).value === "string")) return null;
    return value as PrivateAccessIdentityRule[];
  } catch {
    return null;
  }
};

const storedProviderIds = (state: PrivateDeploymentState): readonly string[] => {
  const encoded = state.resources?.identity_provider_ids;
  if (encoded === undefined) return [];
  try {
    const value = JSON.parse(encoded) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
};

const askRules = async (prompt: BrowserHandoffPrompt): Promise<readonly PrivateAccessIdentityRule[]> => {
  const kind = await askChoice(prompt, "Who may publish through this private deployment?", [
    "People with approved company email domains",
    "Specific email addresses",
  ]);
  for (;;) {
    const answer = await prompt.question(kind === 0
      ? "Approved email domains, separated by commas:\n> "
      : "Approved email addresses, separated by commas:\n> ");
    const values = [...new Set(answer.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
    const valid = kind === 0
      ? values.length > 0 && values.every((value) => domainPattern.test(value))
      : values.length > 0 && values.every((value) => emailPattern.test(value));
    if (valid) return values.map((value) => ({ kind: kind === 0 ? "domain" : "email", value }));
    prompt.write(kind === 0 ? "Enter complete domains such as example.com.\n" : "Enter complete email addresses.\n");
  }
};

const withoutSecretProviderFields = (
  state: PrivateDeploymentState,
  plan: PrivateIdentityPlan,
): PrivateDeploymentState => ({
  ...state,
  resources: {
    ...state.resources,
    identity_mode: plan.mode,
    identity_provider_ids: JSON.stringify(plan.providerIds),
    identity_provider_action: plan.providerAction,
    access_auto_redirect: String(plan.autoRedirectToIdentity),
    access_identity_rules: JSON.stringify(plan.rules),
  },
});

export const runPrivateIdentitySetup = async (
  state: PrivateDeploymentState,
  dependencies: PrivateIdentitySetupDependencies,
): Promise<PrivateIdentitySetupResult> => {
  const accountId = state.cloudflare?.account_id;
  if (accountId === undefined) throw new Error("Cloudflare account discovery must finish before identity setup");
  let providers = await listCloudflareIdentityProviders(dependencies.client, accountId);
  let selected: readonly CloudflareIdentityProviderSummary[] = [];
  let providerAction: PrivateIdentityPlan["providerAction"] = "reuse";
  let rules: readonly PrivateAccessIdentityRule[];
  const storedRules = storedIdentityRules(state);
  if (state.sign_in_mode === "email-code") {
    const otp = providers.find((provider) => provider.type === "onetimepin");
    if (otp !== undefined) selected = [otp];
    else providerAction = "create-after-approval";
    rules = storedRules ?? await askRules(dependencies.prompt);
  } else if (state.sign_in_mode === "company-login") {
    let companyProviders = providers.filter((provider) => provider.type !== "onetimepin");
    if (companyProviders.length === 0) {
      const readiness = "At least one non-OTP company identity provider appears in Cloudflare Zero Trust.";
      const handoff = await runBrowserHandoff({
        title: "Add your company login to Cloudflare",
        purpose: "Your teammates will sign in through a provider already configured and owned in Cloudflare.",
        cloudflareChange: "Your administrator adds the company's Google Workspace, Microsoft, Okta, or other supported provider. Provider credentials stay in Cloudflare.",
        artifactpassReads: "Provider ID, display name, type, and Cloudflare configuration status. ArtifactPass never reads provider secrets.",
        readiness,
        url: cloudflareIdentityProviderUrl(accountId),
      }, {
        prompt: dependencies.prompt,
        openBrowser: dependencies.openBrowser,
        ...(dependencies.copyLink === undefined ? {} : { copyLink: dependencies.copyLink }),
        check: async () => {
          providers = await listCloudflareIdentityProviders(dependencies.client, accountId);
          companyProviders = providers.filter((provider) => provider.type !== "onetimepin");
          return companyProviders.length > 0
            ? { status: "ready", evidence: { provider_count: companyProviders.length } }
            : { status: "pending", message: "No company identity provider is configured yet." };
        },
      });
      if (handoff.status !== "ready") return { status: "saved", state, message: handoff.message };
    }
    const recordedProviderIds = storedProviderIds(state);
    const recordedProviders = recordedProviderIds.map((id) => companyProviders.find((provider) => provider.id === id));
    selected = storedRules !== null && recordedProviders.length > 0 && recordedProviders.every(Boolean)
      ? recordedProviders as readonly CloudflareIdentityProviderSummary[]
      : await askMultiple(dependencies.prompt, "Which company login providers may be used for ArtifactPass?", companyProviders);
    rules = storedRules ?? [{ kind: "authenticated", value: "selected-providers" }];
  } else {
    throw new Error("Choose how people sign in before identity setup");
  }
  const plan = validatePrivateIdentityPlan({
    mode: state.sign_in_mode,
    providerIds: selected.map(({ id }) => id),
    providerAction,
    autoRedirectToIdentity: selected.length === 1 || providerAction === "create-after-approval",
    rules,
    providerDisplayDigest: identityProviderDisplayDigest(selected),
  });
  const updated = provePrivateDeploymentCheckpoint(
    withoutSecretProviderFields(state, plan),
    "identity-ready",
    {
      mode: plan.mode,
      provider_ids: plan.providerIds,
      provider_action: plan.providerAction,
      provider_display_digest: plan.providerDisplayDigest,
      auto_redirect: plan.autoRedirectToIdentity,
      rules: plan.rules,
    },
    "identity-ready",
    (dependencies.now ?? (() => new Date()))(),
  );
  return {
    status: "ready",
    state: updated,
    message: "Cloudflare login providers and the private publisher audience are ready for approval.",
    plan,
  };
};
