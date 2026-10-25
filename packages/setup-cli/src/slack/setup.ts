import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runProcess, type ProcessRunner } from "../process";
import { promptForChoice, type TerminalPrompt } from "../terminal-prompt";
import {
  createSlackArchiveConfiguration,
  readSlackArchiveConfiguration,
  writeSlackArchiveConfiguration,
} from "./configuration";
import { provisionSlackResources } from "./deployment";
import { createSlackBootstrapManifest } from "./manifest";

export interface SlackSetupOptions {
  readonly statePath: string;
  readonly deploymentRoot: string;
  readonly prompt: TerminalPrompt;
  readonly runner?: ProcessRunner;
}

interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
}

const accountsFor = async (runner: ProcessRunner, prompt: TerminalPrompt): Promise<CloudflareAccount[]> => {
  const whoami = async () => {
    const result = await runner("wrangler", ["whoami", "--json"]);
    return JSON.parse(result.stdout) as unknown;
  };
  let identity: unknown;
  try {
    identity = await whoami();
  } catch {
    identity = null;
  }
  if (!identity || typeof identity !== "object" || !("loggedIn" in identity) || identity.loggedIn !== true) {
    prompt.write("Connect Cloudflare. Wrangler will print its authorization URL below; open it in the browser profile you choose.\n");
    await runner("wrangler", ["login", "--browser=false", "--use-keyring"], {
      onOutput: chunk => prompt.write(chunk),
      timeoutMilliseconds: 10 * 60 * 1_000,
    });
    identity = await whoami();
  }
  if (!identity || typeof identity !== "object" || !("loggedIn" in identity) || identity.loggedIn !== true ||
      !("accounts" in identity) || !Array.isArray(identity.accounts)) {
    throw new Error("Cloudflare authorization did not return an account. Finish login and run `artifactpass slack setup` again.");
  }
  const accounts = identity.accounts.filter((item): item is CloudflareAccount =>
    typeof item === "object" && item !== null &&
    "id" in item && typeof item.id === "string" && /^[a-f0-9]{32}$/u.test(item.id) &&
    "name" in item && typeof item.name === "string");
  if (accounts.length === 0) throw new Error("No usable Cloudflare account was found");
  return accounts;
};

export const runSlackSetup = async (options: SlackSetupOptions): Promise<string> => {
  if (!options.prompt.interactive) throw new Error("Slack archive setup needs an interactive terminal");
  const prompt = options.prompt;
  const runner = options.runner ?? runProcess;
  const config = await readSlackArchiveConfiguration(options.statePath) ?? createSlackArchiveConfiguration();
  prompt.intro?.("ArtifactPass Slack archive");
  prompt.write([
    "This separate add-on copies approved live ArtifactPass links into their Slack message threads.",
    "Your Cloudflare account owns one Worker, Queue, and D1 database. ArtifactPass does not receive the bot token or archived file bytes.",
    "The account must have a workers.dev subdomain so Slack can reach its event receiver. Cloudflare can set one up in Workers & Pages.",
    "The Slack app needs only links:read and files:write. No message-history scope is requested.",
    "A Slack copy follows your workspace retention policy and cannot be revoked by expiring the original ArtifactPass link.",
    "Cloudflare Free planning budget: up to 3,000 archived files/day across this account, only if other usage and retries leave room. This is not yet load-tested.",
    "Cloudflare account dashboard: https://dash.cloudflare.com/",
    "Slack app dashboard: https://api.slack.com/apps",
    "",
  ].join("\n"));

  if (config.worker_url) {
    if (config.app_id) {
      return [
        `Archive Worker: ${config.worker_url}`,
        `Slack app: ${config.app_id}`,
        `Enabled channels: ${config.enabled_channels.length}`,
        "Run `pnpm dlx artifactpass slack status` for live delivery counts. Add a channel with `pnpm dlx artifactpass slack channels add <channel-link-or-id>`.",
      ].join("\n");
    }
    const path = join(dirname(options.statePath), "bootstrap-manifest.json");
    await writeFile(path, `${JSON.stringify(createSlackBootstrapManifest(config), null, 2)}\n`, { mode: 0o600 });
    return [
      `Archive Worker: ${config.worker_url}`,
      `Bootstrap Slack app manifest: ${path}`,
      "Create a Slack app from that manifest at https://api.slack.com/apps?new_app=1 and install it in the intended workspace.",
      `In Cloudflare, open https://dash.cloudflare.com/${config.account_id}/workers-and-pages and select ${config.worker_name}. Add SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET as Worker secrets.`,
      "Then run: pnpm dlx artifactpass slack activate --team-id T1234567890 --app-id A1234567890 (replace both IDs with the ones in your Slack app).",
      "Archiving is not active yet. No channel is enabled.",
    ].join("\n");
  }

  const accounts = await accountsFor(runner, prompt);
  const selection = await promptForChoice(prompt, "Choose the Cloudflare account for this Slack archive", accounts.map(account => `${account.name} (${account.id})`));
  const account = accounts[selection];
  if (!account) throw new Error("Choose a Cloudflare account");
  const prepared = { ...config, account_id: account.id };
  await writeSlackArchiveConfiguration(options.statePath, prepared);
  prompt.write(`Cloudflare will create one Worker, one Queue, and one D1 database in ${account.name}. No plan upgrade is requested.\n`);
  const approval = await promptForChoice(prompt, "What should ArtifactPass do?", ["Approve and deploy these resources", "Save and exit"]);
  if (approval !== 0) return `Slack setup saved. No Cloudflare resources were created. Resume: pnpm dlx artifactpass slack setup`;

  const activity = prompt.activity?.("Creating the customer-owned Slack archive resources");
  let deployed;
  try {
    deployed = await provisionSlackResources(prepared, {
      accountId: account.id,
      statePath: options.statePath,
      deploymentRoot: options.deploymentRoot,
      runner,
      approved: true,
    });
    activity?.succeed("Archive Worker, Queue, and D1 database created");
  } catch (error) {
    activity?.fail("Cloudflare provisioning stopped. Your progress is saved for resume.");
    throw error;
  }
  const manifestPath = join(dirname(options.statePath), "bootstrap-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(createSlackBootstrapManifest(deployed), null, 2)}\n`, { mode: 0o600 });
  return [
    `Archive Worker: ${deployed.worker_url}`,
    `Bootstrap Slack app manifest: ${manifestPath}`,
    "Open https://api.slack.com/apps?new_app=1 in your chosen browser profile. Create an app from the manifest and install it in the intended workspace.",
    `In Cloudflare, open https://dash.cloudflare.com/${account.id}/workers-and-pages and select ${deployed.worker_name}. Add SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET as Worker secrets.`,
    "Then run: pnpm dlx artifactpass slack activate --team-id T1234567890 --app-id A1234567890 (replace both IDs with your Slack app IDs).",
    "Archiving is still off. No channel is enabled, and the app's signed event subscription has not been activated.",
    "Resume: pnpm dlx artifactpass slack setup",
  ].join("\n");
};
