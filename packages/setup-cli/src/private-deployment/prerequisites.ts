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
import { promptForChoice, promptForText } from "../terminal-prompt";
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
  readonly persist?: (state: PrivateDeploymentState) => Promise<PrivateDeploymentState>;
}

export interface PrivateDeploymentPrerequisiteResult {
  readonly status: "ready" | "saved" | "permission-denied" | "conflict";
  readonly state: PrivateDeploymentState;
  readonly message: string;
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const workersSubdomainPattern = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const cloudflareDomainGuideUrl = "https://github.com/lordelogos/lordebuilds.artifact.pass/blob/main/docs/cloudflare-domain-setup.md";

const askDomain = async (prompt: BrowserHandoffPrompt): Promise<string> => {
  for (;;) {
    const domain = (await promptForText(
      prompt,
      "Domain to add to Cloudflare (example: example.com; no https://)",
      "example.com",
    )).trim().toLowerCase().replace(/\.$/u, "");
    if (domainPattern.test(domain)) return domain;
    prompt.write("Enter only the domain, for example example.com. Do not include https:// or a path.\n");
  }
};

const chooseWorkersSubdomain = async (
  prompt: BrowserHandoffPrompt,
  accountName: string,
): Promise<string> => {
  const suggestion = suggestWorkersSubdomain(accountName);
  const explanation = "Cloudflare requires one account-wide workers.dev name before it can deploy Workers. This is a technical fallback; people will use your chosen ArtifactPass domain.";
  if (prompt.note === undefined) prompt.write(`${explanation}\n`);
  else prompt.note(explanation, "Cloudflare Worker address");
  const selection = await promptForChoice(prompt, "Which workers.dev name should Cloudflare use?", [
    `Use ${suggestion}`,
    "Enter another name",
  ]);
  if (selection === 0) return suggestion;
  for (;;) {
    const value = (await promptForText(prompt, "Workers subdomain name", "company-artifacts")).trim().toLowerCase();
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
): PrivateDeploymentState => ({
  ...state,
  pending_handoff: { kind, readiness },
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
    : await promptForChoice(dependencies.prompt, "Which Cloudflare account should own this private ArtifactPass deployment?", accounts.map((account) => account.name));
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
      : await promptForChoice(dependencies.prompt, "Which domain should ArtifactPass use?", [
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
  nextState = pendingState(nextState, "domain", readiness);
  nextState = await (dependencies.persist ?? (async (value) => value))(nextState);
  const handoff = await runBrowserHandoff({
    title: zone === undefined ? "Add your domain to Cloudflare" : "Activate your domain in Cloudflare",
    purpose: "ArtifactPass needs a domain you control for the private Worker and team login.",
    cloudflareChange: "Choose Connect a domain, not Transfer a domain. Cloudflare adds the DNS zone and shows the nameservers. You update those nameservers at your current registrar. This does not transfer your domain registration, unlock the domain, or require an authorization code. ArtifactPass never receives registrar credentials.",
    artifactpassReads: "The zone ID, domain name, assigned nameservers, and activation status.",
    readiness,
    guideUrl: cloudflareDomainGuideUrl,
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
): Promise<{
  readonly result: PrivateDeploymentPrerequisiteResult | null;
  readonly state: PrivateDeploymentState;
}> => {
  const accountId = state.cloudflare?.account_id as string;
  const current = kind === "r2" ? snapshot.r2 : snapshot.zeroTrust;
  if (current.status === "permission-denied") {
    return { result: { status: "permission-denied", state, message: current.message }, state };
  }
  if (current.status === "ready") return { result: null, state };
  const readiness = kind === "r2"
    ? "ArtifactPass can list R2 buckets in this account."
    : "ArtifactPass can read the account's Zero Trust team domain.";
  const pending = await (dependencies.persist ?? (async (value) => value))(pendingState(state, kind, readiness));
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
    return {
      result: {
        status: result.status === "conflict" ? "conflict" : result.status === "permission-denied" ? "permission-denied" : "saved",
        state: pending,
        message: result.message,
      },
      state: pending,
    };
  }
  return { result: null, state: pending };
};

export const runPrivateDeploymentPrerequisites = async (
  initialState: PrivateDeploymentState,
  dependencies: PrivateDeploymentPrerequisiteDependencies,
): Promise<PrivateDeploymentPrerequisiteResult> => {
  const persist = dependencies.persist ?? (async (state: PrivateDeploymentState) => state);
  const selectedAccount = await chooseAccount(initialState, dependencies);
  const account = {
    ...selectedAccount,
    state: await persist(selectedAccount.state),
  };
  const zoneResult = await ensureActiveZone(account.state, dependencies);
  if ("status" in zoneResult) return zoneResult;
  let state = await persist(zoneResult.state);
  const accountId = state.cloudflare?.account_id as string;
  let snapshot = await inspectCloudflarePrerequisites(dependencies.client, accountId);
  if (snapshot.d1.status !== "ready") {
    return { status: snapshot.d1.status === "permission-denied" ? "permission-denied" : "saved", state, message: snapshot.d1.message };
  }
  for (const kind of ["r2", "zero-trust"] as const) {
    const beforeHandoff = kind === "r2" ? snapshot.r2 : snapshot.zeroTrust;
    const handoff = await handoffForPrerequisite(kind, state, snapshot, dependencies);
    state = handoff.state;
    if (handoff.result !== null) return handoff.result;
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
  state = await persist(state);
  return {
    status: "ready",
    state,
    message: "Cloudflare account, domain, D1, R2, Zero Trust, and Workers prerequisites are ready.",
  };
};
