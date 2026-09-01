import type { CloudflareClient } from "../cloudflare/client";
import {
  cloudflareDashboardUrls,
  inspectCloudflarePrerequisites,
  listCloudflareAccounts,
  listCloudflareZones,
  suggestWorkersSubdomain,
  type CloudflarePrerequisiteSnapshot,
  type CloudflareZoneSummary,
} from "../cloudflare/discovery";
import { runBrowserHandoff, type BrowserHandoffPrompt } from "./browser-handoff";
import {
  provePrivateDeploymentCheckpoint,
  type PrivateDeploymentState,
} from "./deployment-state";

export interface PrivateDeploymentPrerequisiteDependencies {
  readonly client: CloudflareClient;
  readonly prompt: BrowserHandoffPrompt;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly copyLink?: (url: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface PrivateDeploymentPrerequisiteResult {
  readonly status: "ready" | "saved" | "permission-denied" | "conflict";
  readonly state: PrivateDeploymentState;
  readonly message: string;
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const workersSubdomainPattern = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

const askChoice = async (
  prompt: BrowserHandoffPrompt,
  question: string,
  options: readonly string[],
): Promise<number> => {
  for (;;) {
    const answer = await prompt.question(`${question}\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n> `);
    const selected = Number.parseInt(answer.trim(), 10);
    if (Number.isInteger(selected) && selected >= 1 && selected <= options.length) return selected - 1;
    prompt.write(`Choose a number from 1 to ${options.length}.\n`);
  }
};

const askDomain = async (prompt: BrowserHandoffPrompt): Promise<string> => {
  for (;;) {
    const domain = (await prompt.question("Domain to add to Cloudflare:\n> ")).trim().toLowerCase().replace(/\.$/u, "");
    if (domainPattern.test(domain)) return domain;
    prompt.write("Enter a complete domain such as example.com.\n");
  }
};

const chooseWorkersSubdomain = async (
  prompt: BrowserHandoffPrompt,
  accountName: string,
): Promise<string> => {
  const suggestion = suggestWorkersSubdomain(accountName);
  const selection = await askChoice(prompt, "This account needs one shared workers.dev subdomain. What should ArtifactPass plan?", [
    `Use ${suggestion}`,
    "Enter another name",
  ]);
  if (selection === 0) return suggestion;
  for (;;) {
    const value = (await prompt.question("Workers subdomain name:\n> ")).trim().toLowerCase();
    if (workersSubdomainPattern.test(value)) return value;
    prompt.write("Use 1 to 63 lowercase letters, numbers, or hyphens.\n");
  }
};

const updateCloudflareSelection = (
  state: PrivateDeploymentState,
  selection: NonNullable<PrivateDeploymentState["cloudflare"]>,
): PrivateDeploymentState => ({
  ...state,
  cloudflare: { ...state.cloudflare, ...selection },
});

const pendingState = (
  state: PrivateDeploymentState,
  kind: NonNullable<PrivateDeploymentState["pending_handoff"]>["kind"],
  readiness: string,
  now: Date,
): PrivateDeploymentState => ({
  ...state,
  pending_handoff: { kind, readiness },
  updated_at: now.toISOString(),
});

const clearPending = (state: PrivateDeploymentState): PrivateDeploymentState => {
  const { pending_handoff: _pending, ...remaining } = state;
  return remaining;
};

const chooseAccount = async (
  state: PrivateDeploymentState,
  dependencies: PrivateDeploymentPrerequisiteDependencies,
): Promise<{ readonly state: PrivateDeploymentState; readonly accountName: string }> => {
  const accounts = await listCloudflareAccounts(dependencies.client);
  if (accounts.length === 0) throw new Error("This Cloudflare login does not have access to an account");
  const recorded = accounts.find((account) => account.id === state.cloudflare?.account_id);
  if (recorded !== undefined) return { state, accountName: recorded.name };
  const selected = accounts.length === 1
    ? 0
    : await askChoice(dependencies.prompt, "Which Cloudflare account should own this private ArtifactPass deployment?", accounts.map((account) => account.name));
  const account = accounts[selected];
  if (account === undefined) throw new Error("The selected Cloudflare account is unavailable");
  return {
    state: provePrivateDeploymentCheckpoint(
      updateCloudflareSelection(state, { account_id: account.id, account_name: account.name }),
      "account-selected",
      { account_id: account.id },
      "account-selected",
      (dependencies.now ?? (() => new Date()))(),
    ),
    accountName: account.name,
  };
};

const ensureActiveZone = async (
  state: PrivateDeploymentState,
  dependencies: PrivateDeploymentPrerequisiteDependencies,
): Promise<PrivateDeploymentPrerequisiteResult | { readonly state: PrivateDeploymentState }> => {
  const accountId = state.cloudflare?.account_id;
  if (accountId === undefined) throw new Error("Choose a Cloudflare account first");
  let zones = await listCloudflareZones(dependencies.client, accountId);
  let zone: CloudflareZoneSummary | undefined = zones.find((candidate) =>
    candidate.id === state.cloudflare?.zone_id || candidate.name === state.cloudflare?.zone_name);
  let nextState = state;
  if (zone === undefined) {
    const selection = zones.length === 0
      ? zones.length
      : await askChoice(dependencies.prompt, "Which domain should ArtifactPass use?", [
        ...zones.map((candidate) => `${candidate.name} (${candidate.status})`),
        "Add another domain to Cloudflare",
      ]);
    if (selection < zones.length) {
      zone = zones[selection];
    } else {
      const domain = state.cloudflare?.zone_name ?? await askDomain(dependencies.prompt);
      nextState = updateCloudflareSelection(state, { zone_name: domain });
    }
  }
  if (zone !== undefined) {
    nextState = updateCloudflareSelection(nextState, {
      zone_id: zone.id,
      zone_name: zone.name,
    });
    if (zone.status === "active") {
      return {
        state: provePrivateDeploymentCheckpoint(
          clearPending(nextState),
          "zone-active",
          { zone_id: zone.id, zone_name: zone.name },
          "zone-active",
          (dependencies.now ?? (() => new Date()))(),
        ),
      };
    }
  }
  const domain = nextState.cloudflare?.zone_name;
  if (domain === undefined) throw new Error("Choose a domain before opening Cloudflare");
  const readiness = `${domain} appears in this account with status Active.`;
  nextState = pendingState(nextState, "domain", readiness, (dependencies.now ?? (() => new Date()))());
  const handoff = await runBrowserHandoff({
    title: zone === undefined ? "Add your domain to Cloudflare" : "Activate your domain in Cloudflare",
    purpose: "ArtifactPass needs a domain you control for the private Worker and team login.",
    cloudflareChange: "Cloudflare adds the DNS zone and shows the nameservers. You update those nameservers at your registrar. ArtifactPass never receives registrar credentials.",
    artifactpassReads: "The zone ID, domain name, assigned nameservers, and activation status.",
    readiness,
    url: cloudflareDashboardUrls(accountId).addDomain,
    resumed: state.pending_handoff?.kind === "domain",
  }, {
    prompt: dependencies.prompt,
    openBrowser: dependencies.openBrowser,
    ...(dependencies.copyLink === undefined ? {} : { copyLink: dependencies.copyLink }),
    check: async () => {
      zones = await listCloudflareZones(dependencies.client, accountId);
      const candidate = zones.find((item) => item.name === domain);
      if (candidate?.status === "active") {
        zone = candidate;
        return { status: "ready", evidence: { zone_id: candidate.id, zone_name: candidate.name } };
      }
      return { status: "pending", message: candidate === undefined ? `${domain} is not in this account yet.` : `${domain} is still ${candidate.status}.` };
    },
  });
  if (handoff.status !== "ready") {
    return { status: handoff.status === "conflict" ? "conflict" : handoff.status === "permission-denied" ? "permission-denied" : "saved", state: nextState, message: handoff.message };
  }
  zone ??= zones.find((candidate) => candidate.name === domain && candidate.status === "active");
  if (zone === undefined) throw new Error("Cloudflare reported the domain ready without an active zone");
  return {
    state: provePrivateDeploymentCheckpoint(
      clearPending(updateCloudflareSelection(nextState, { zone_id: zone.id, zone_name: zone.name })),
      "zone-active",
      { zone_id: zone.id, zone_name: zone.name },
      "zone-active",
      (dependencies.now ?? (() => new Date()))(),
    ),
  };
};

const handoffForPrerequisite = async (
  kind: "r2" | "zero-trust",
  state: PrivateDeploymentState,
  snapshot: CloudflarePrerequisiteSnapshot,
  dependencies: PrivateDeploymentPrerequisiteDependencies,
): Promise<PrivateDeploymentPrerequisiteResult | null> => {
  const accountId = state.cloudflare?.account_id as string;
  const current = kind === "r2" ? snapshot.r2 : snapshot.zeroTrust;
  if (current.status === "permission-denied") return { status: "permission-denied", state, message: current.message };
  if (current.status === "ready") return null;
  const readiness = kind === "r2"
    ? "ArtifactPass can list R2 buckets in this account."
    : "ArtifactPass can read the account's Zero Trust team domain.";
  const pending = pendingState(state, kind, readiness, (dependencies.now ?? (() => new Date()))());
  const urls = cloudflareDashboardUrls(accountId);
  const result = await runBrowserHandoff(kind === "r2" ? {
    title: "Enable R2 in Cloudflare",
    purpose: "ArtifactPass stores temporary artifact bytes in a private R2 bucket owned by your account.",
    cloudflareChange: "Cloudflare completes first-time R2 setup and shows any plan or payment terms. ArtifactPass does not choose or accept them.",
    artifactpassReads: "Whether R2 bucket listing is available.",
    readiness,
    url: urls.r2,
  } : {
    title: "Set up Cloudflare Zero Trust",
    purpose: "Cloudflare Access protects your private upload and agent-approval pages.",
    cloudflareChange: "Cloudflare creates your team name and shows any plan or payment terms. ArtifactPass does not choose or accept them.",
    artifactpassReads: "The Zero Trust team domain and configured identity providers.",
    readiness,
    url: urls.zeroTrust,
  }, {
    prompt: dependencies.prompt,
    openBrowser: dependencies.openBrowser,
    ...(dependencies.copyLink === undefined ? {} : { copyLink: dependencies.copyLink }),
    check: async () => {
      const refreshed = await inspectCloudflarePrerequisites(dependencies.client, accountId);
      const candidate = kind === "r2" ? refreshed.r2 : refreshed.zeroTrust;
      return candidate.status === "ready"
        ? { status: "ready", evidence: candidate.evidence }
        : candidate;
    },
  });
  if (result.status !== "ready") {
    return { status: result.status === "conflict" ? "conflict" : result.status === "permission-denied" ? "permission-denied" : "saved", state: pending, message: result.message };
  }
  return null;
};

export const runPrivateDeploymentPrerequisites = async (
  initialState: PrivateDeploymentState,
  dependencies: PrivateDeploymentPrerequisiteDependencies,
): Promise<PrivateDeploymentPrerequisiteResult> => {
  const account = await chooseAccount(initialState, dependencies);
  const zoneResult = await ensureActiveZone(account.state, dependencies);
  if ("status" in zoneResult) return zoneResult;
  let state = zoneResult.state;
  const accountId = state.cloudflare?.account_id as string;
  let snapshot = await inspectCloudflarePrerequisites(dependencies.client, accountId);
  if (snapshot.d1.status !== "ready") {
    return { status: snapshot.d1.status === "permission-denied" ? "permission-denied" : "saved", state, message: snapshot.d1.message };
  }
  for (const kind of ["r2", "zero-trust"] as const) {
    const beforeHandoff = kind === "r2" ? snapshot.r2 : snapshot.zeroTrust;
    const handoff = await handoffForPrerequisite(kind, state, snapshot, dependencies);
    if (handoff !== null) return handoff;
    if (beforeHandoff.status !== "ready") {
      snapshot = await inspectCloudflarePrerequisites(dependencies.client, accountId);
    }
  }
  if (snapshot.workersSubdomain.status === "permission-denied") {
    return { status: "permission-denied", state, message: snapshot.workersSubdomain.message };
  }
  const resources: Record<string, string> = { ...state.resources, placement: "automatic" };
  if (snapshot.workersSubdomain.status === "ready") {
    resources.workers_subdomain = String(snapshot.workersSubdomain.evidence.subdomain);
    resources.workers_subdomain_action = "reuse";
  } else {
    resources.workers_subdomain = await chooseWorkersSubdomain(dependencies.prompt, account.accountName);
    resources.workers_subdomain_action = "create-after-approval";
  }
  state = provePrivateDeploymentCheckpoint(
    { ...clearPending(state), resources },
    "prerequisites-ready",
    {
      account_id: accountId,
      zone_id: state.cloudflare?.zone_id,
      d1: "ready",
      r2: "ready",
      zero_trust: "ready",
      workers_subdomain: resources.workers_subdomain,
      workers_subdomain_action: resources.workers_subdomain_action,
      placement: "automatic",
    },
    "prerequisites-ready",
    (dependencies.now ?? (() => new Date()))(),
  );
  return {
    status: "ready",
    state,
    message: "Cloudflare account, domain, D1, R2, Zero Trust, and Workers prerequisites are ready.",
  };
};
