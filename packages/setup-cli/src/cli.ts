import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";

import {
  defaultLocalConfigPath,
  readLocalBridgeSettings,
  redactSensitiveText,
  setActiveLocalBridgeProfile,
  updateLocalBridgeSettings,
} from "agent-bridge";

import { runDeployCommand } from "./commands/deploy";
import {
  renderPrivateDeploymentDoctor,
  runPrivateDeploymentDoctor,
} from "./commands/deployment-doctor";
import { connectHost } from "./commands/connect";
import { disconnectHost, selectDisconnectProfile } from "./commands/disconnect";
import {
  INSTALL_BOOLEAN_OPTIONS,
  INSTALL_VALUE_OPTIONS,
  WORKSPACE_VALUE_OPTIONS,
  firstUnknownOption,
  isInstallInvocation,
  parseConnectArguments,
  parseInstallAgent,
  resolveInstallAgent,
  resolveConnectDeploymentUrl,
} from "./cli-arguments";
import { CloudflareClient } from "./cloudflare/client";
import type { IdentityRule } from "./cloudflare/deployment";
import { activatePublicArtifactPass } from "./cloudflare/public-activation";
import { runDoctor } from "./doctor";
import { runSlackSetup } from "./slack/setup";
import { startSlackArchiveWizard } from "./slack/wizard";
import { activateSlackArchive } from "./slack/activation";
import {
  addSlackChannel,
  addSlackSource,
  readSlackArchiveConfiguration,
  removeSlackChannel,
  removeSlackSource,
  writeSlackArchiveConfiguration,
  type SlackArchiveConfiguration,
} from "./slack/configuration";
import { provisionSlackResources } from "./slack/deployment";
import { createSlackAppManifest, createSlackInitialManifest } from "./slack/manifest";
import { readSlackArchiveStatus, slackArchiveRecoveryHint } from "./slack/status";
import { uninstallSlackArchive } from "./slack/uninstall";
import { openBrowser } from "./open-browser";
import { migrateDefaultLocalState } from "./local-state-migration";
import {
  parsePrivateDeploymentWizardArguments,
  renderPrivateDeploymentWizardResult,
  runPrivateDeploymentWizard,
} from "./private-deployment/deploy-wizard";
import {
  authorizePrivateDeployment,
  disconnectPrivateDeploymentAuthorization,
  privateDeploymentAccessTokenForInspection,
  privateDeploymentAuthorizationStatus,
  type PrivateDeploymentAuthorizationSession,
} from "./private-deployment/deployment-authorization";
import {
  privateDeploymentStateRoot,
  resolvePrivateDeploymentState,
  withPrivateDeploymentLock,
  writePrivateDeploymentState,
  type PrivateDeploymentState,
} from "./private-deployment/deployment-state";
import { runPrivateDeploymentPrerequisites } from "./private-deployment/prerequisites";
import { runPrivateIdentitySetup } from "./private-deployment/identity-setup";
import { runPrivateRetentionSetup } from "./private-deployment/retention";
import { runPrivateDeploymentApproval } from "./private-deployment/deployment-approval";
import {
  ArtifactpassInstallError,
  renderInstallFailure,
  renderInstallReceipt,
  runArtifactpassInstall,
} from "./installer";
import {
  applyWorkspaceConfiguration,
  resolveWorkspaceConfiguration,
} from "./workspace-configuration";
import { listWorkspaceAccess, removeWorkspaceAccess } from "./workspace-access";
import {
  createNonInteractiveTerminalPrompt,
  createTerminalPrompt,
  promptForChoice,
  TerminalPromptCancelledError,
  type TerminalPrompt,
} from "./terminal-prompt";

const deploymentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "deployment");
const defaultMarketplace = resolve(dirname(fileURLToPath(import.meta.url)), "marketplace");
const slackDeploymentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "slack-archive");
const slackStatePath = resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
  "artifactpass", "slack-archive", "configuration.json");

const values = (args: readonly string[], flag: string): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    result.push(value);
  }
  return result;
};

const value = (args: readonly string[], flag: string): string => {
  const matches = values(args, flag);
  if (matches.length !== 1) throw new Error(`${flag} must be provided exactly once`);
  return matches[0] ?? "";
};

const optionalValue = (args: readonly string[], flag: string): string | undefined => {
  const matches = values(args, flag);
  if (matches.length > 1) throw new Error(`${flag} may be provided once`);
  return matches[0];
};

const booleanFlag = (args: readonly string[], flag: string): boolean => {
  const count = args.filter((argument) => argument === flag).length;
  if (count > 1) throw new Error(`${flag} may be provided once`);
  return count === 1;
};

const positionalValues = (args: readonly string[]): string[] =>
  args.filter((item, index) => index === 0 || !args[index - 1]?.startsWith("--"))
    .filter((item) => !item.startsWith("--"));

const optionalPositional = (args: readonly string[], position: number): string | undefined =>
  positionalValues(args)[position];

const print = (valueToPrint: unknown): void => {
  process.stdout.write(`${typeof valueToPrint === "string" ? valueToPrint : JSON.stringify(valueToPrint, null, 2)}\n`);
};

const help = `ArtifactPass setup

Commands:
  artifactpass [--json]
  install [--agent codex|claude|gemini|kimi|cursor|vscode|antigravity|other] [--base-url <url>] [--profile <name>] [--workspace-root <path>] [--open-development] [--no-host-install] [--json]
  configure [--base-url <url>] [--profile <name>] [--workspace-root <path>] [--open-development] [--json]
  deploy-public --account-id <id> --zone-id <id> --hostname <host> [--service-name <name>] --workers-subdomain <name> --pdf-key-id <id> --pdf-public-key <base64> --google-client-id <id> --github-client-id <id> [--production-existing-resources] (--dry-run | --write-approval-manifest <path> | --approve-manifest <path>)
  activate-public --account-id <id> --hostname <host> [--service-name <name>] (--write-approval-manifest <path> | --approve-manifest <path>)
  deploy [--resume <hostname-or-id> | --new] [--status] [--abandon] [--no-save-authorization] [--non-interactive] [--json]
  deployment auth status --resume <hostname-or-id> [--json]
  deployment auth disconnect --resume <hostname-or-id> [--json]
  deployment doctor --resume <hostname-or-id> [--json]
  deploy --account-id <id> --zone-id <id> --hostname <host> [--service-name <name>] --workers-subdomain <name> --pdf-key-id <id> --pdf-public-key <base64> (--allow-email <email> | --allow-domain <domain>) (--dry-run | --write-approval-manifest <path> | --approve-manifest <path>)
  connect [base-url] [--profile <name>] [--workspace-root <path>] [--open-development]
  profile list
  profile use <name>
  workspace list
  workspace remove <path> [--profile <name>]
  disconnect [--profile <name>]
  doctor
  slack setup
  slack activate --team-id <id> --app-id <id>
  slack status
  slack sources add|remove <https-origin>
  slack channels add <channel-link-or-id> [more channel links or IDs]
  slack channels remove <channel-link-or-id>
  slack pause|resume|update
  slack rotate|uninstall

Private setup uses ArtifactPass Cloudflare OAuth and stores its refresh grant in your OS credential store. CLOUDFLARE_API_TOKEN remains an environment-only fallback.`;

const requiredEnvironment = (name: string): string => {
  const result = process.env[name];
  if (result === undefined || result.length === 0) throw new Error(`${name} is required`);
  return result;
};

let jsonOutputRequested = false;
let activePrivateDeploymentResumeCommand: string | undefined;

const readSavedSettings = async () => {
  await migrateDefaultLocalState();
  return readLocalBridgeSettings(defaultLocalConfigPath()).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
};

const resolveCliWorkspaceConfiguration = async (
  args: readonly string[],
  forceInteractive: boolean,
  providedPrompt?: TerminalPrompt,
) => {
  const baseUrl = optionalValue(args, "--base-url");
  const profileName = optionalValue(args, "--profile");
  const workspaceRoot = resolve(optionalValue(args, "--workspace-root") ?? process.cwd());
  const openDevelopment = booleanFlag(args, "--open-development");
  const settings = await readSavedSettings();
  const terminalIsInteractive = process.stdin.isTTY === true && process.stderr.isTTY === true && !jsonOutputRequested;
  const interactive = baseUrl === undefined && profileName === undefined && terminalIsInteractive;
  if (forceInteractive && !interactive && baseUrl === undefined && profileName === undefined) {
    throw new Error("ArtifactPass configure needs an interactive terminal or --base-url");
  }
  const prompt = providedPrompt ?? (interactive
    ? await createTerminalPrompt()
    : createNonInteractiveTerminalPrompt());
  if (interactive && providedPrompt === undefined) prompt.intro?.("ArtifactPass configuration");
  const resolved = await resolveWorkspaceConfiguration({
    workspaceRoot,
    settings,
    interactive,
    prompt,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(profileName === undefined ? {} : { profileName }),
    openDevelopment,
  });
  return { resolved, settings, openDevelopment, prompt: interactive ? prompt : undefined };
};

const resolveCliInstallConfiguration = async (args: readonly string[]) => {
  const requestedAgent = parseInstallAgent(args);
  const installKnownHostAdapters = !booleanFlag(args, "--no-host-install");
  if (!installKnownHostAdapters && requestedAgent !== undefined) {
    throw new Error("--agent cannot be combined with --no-host-install");
  }
  const terminalIsInteractive = process.stdin.isTTY === true && process.stderr.isTTY === true && !jsonOutputRequested;
  const agentInteractive = installKnownHostAdapters && requestedAgent === undefined && terminalIsInteractive;
  const workspaceInteractive = optionalValue(args, "--base-url") === undefined &&
    optionalValue(args, "--profile") === undefined && terminalIsInteractive;
  const prompt = agentInteractive || workspaceInteractive
    ? await createTerminalPrompt()
    : createNonInteractiveTerminalPrompt();
  if (agentInteractive || workspaceInteractive) prompt.intro?.("ArtifactPass setup");
  const hosts = installKnownHostAdapters
    ? await resolveInstallAgent(requestedAgent, agentInteractive, prompt)
    : undefined;
  const workspace = await resolveCliWorkspaceConfiguration(args, false, prompt);
  return { ...workspace, hosts, prompt: agentInteractive || workspaceInteractive ? prompt : undefined };
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (isInstallInvocation(command)) {
    const installArgs = command === "install" ? args : process.argv.slice(2);
    jsonOutputRequested = booleanFlag(installArgs, "--json");
    const unexpected = firstUnknownOption(installArgs, INSTALL_VALUE_OPTIONS, INSTALL_BOOLEAN_OPTIONS);
    if (unexpected !== undefined) throw new Error(`Unknown install option: ${unexpected}`);
    const configuration = await resolveCliInstallConfiguration(installArgs);
    const receipt = await runArtifactpassInstall({
      marketplaceSource: defaultMarketplace,
      baseUrl: configuration.resolved.baseUrl,
      profileName: configuration.resolved.profileName,
      workspaceRoot: configuration.resolved.workspaceRoot,
      openDevelopment: configuration.openDevelopment,
      connectAfterInstall: false,
      installKnownHostAdapters: !booleanFlag(installArgs, "--no-host-install"),
      ...(configuration.hosts === undefined ? {} : { hosts: configuration.hosts }),
    }, {
      connectDependencies: {
        deviceFlowDependencies: {
          openBrowser,
          onManualApprovalRequired: (url) => {
            process.stderr.write(`Open this URL to approve ArtifactPass:\n${url}\n`);
          },
        },
      },
    });
    if (jsonOutputRequested) print(receipt);
    else {
      print(renderInstallReceipt(receipt));
      configuration.prompt?.outro?.("Setup complete");
    }
    return;
  }
  if (command === "configure") {
    jsonOutputRequested = booleanFlag(args, "--json");
    const configureBooleanOptions = new Set(["--open-development", "--json"]);
    const unexpected = firstUnknownOption(args, WORKSPACE_VALUE_OPTIONS, configureBooleanOptions);
    if (unexpected !== undefined) throw new Error(`Unknown configure option: ${unexpected}`);
    const configuration = await resolveCliWorkspaceConfiguration(args, true);
    await updateLocalBridgeSettings(defaultLocalConfigPath(), (current) =>
      applyWorkspaceConfiguration(
        current,
        configuration.resolved,
        configuration.openDevelopment,
      ));
    if (jsonOutputRequested) {
      print({
        profile: configuration.resolved.profileName,
        origin: configuration.resolved.baseUrl,
        workspace_root: configuration.resolved.workspaceRoot,
        connection_status: "not-checked",
      });
    } else {
      const message = `ArtifactPass now uses ${configuration.resolved.baseUrl} for ${configuration.resolved.workspaceRoot}. Running agent sessions pick up this project access on their next ArtifactPass tool call. If this deployment is not connected, connect from the agent when you first use it.`;
      print(message);
      configuration.prompt?.outro?.("Configuration saved");
    }
    return;
  }
  if (command === "help" || command === "--help") {
    print(help);
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor(deploymentRoot);
    print(result);
    if (!result.node || !result.wrangler || !result.deploymentAssets) process.exitCode = 1;
    return;
  }
  if (command === "slack") {
    const withSlackActivity = async <Result>(message: string, action: () => Promise<Result>): Promise<Result> => {
      const prompt = await createTerminalPrompt();
      const activity = prompt.interactive ? prompt.activity?.(message) : undefined;
      if (!activity) prompt.write(`${message}...\n`);
      try {
        const result = await action();
        activity?.succeed(message);
        return result;
      } catch (error) {
        activity?.fail(`${message} failed`);
        throw error;
      }
    };
    const requireSlackConfiguration = async () => {
      const current = await readSlackArchiveConfiguration(slackStatePath);
      if (!current) throw new Error("Run `artifactpass slack setup` first");
      return current;
    };
    const applySlackConfiguration = async (next: SlackArchiveConfiguration): Promise<SlackArchiveConfiguration> => {
      await writeSlackArchiveConfiguration(slackStatePath, next);
      if (!next.account_id || !next.worker_url) return next;
      const accountId = next.account_id;
      return withSlackActivity("Updating the customer-owned archive Worker", () => provisionSlackResources(next, {
        accountId,
        statePath: slackStatePath,
        deploymentRoot: slackDeploymentRoot,
        approved: true,
      }));
    };
    if (args[0] === "setup" && (args.length === 1 || (args.length === 2 && args[1] === "--terminal"))) {
      if (args[1] === "--terminal") {
        const prompt = await createTerminalPrompt();
        print(await runSlackSetup({ statePath: slackStatePath, deploymentRoot: slackDeploymentRoot, prompt }));
        return;
      }
      const wizard = await startSlackArchiveWizard({
        statePath: slackStatePath,
        deploymentRoot: slackDeploymentRoot,
        htmlPath: resolve(dirname(fileURLToPath(import.meta.url)), "slack-wizard.html"),
      });
      const prompt = await createTerminalPrompt();
      const handoff = "Open the link below in the browser profile you want. Keep this terminal open while using the wizard.\nPress Ctrl+C to stop; your progress is saved locally.";
      if (prompt.interactive && prompt.intro && prompt.note) {
        prompt.intro("ArtifactPass Slack archive");
        prompt.note(handoff, "Local setup ready");
        prompt.write(`${wizard.url}\n`);
      } else {
        print(`ArtifactPass Slack archive setup is ready.\n${handoff}\n${wizard.url}`);
      }
      await wizard.closed;
      return;
    }
    if (args[0] === "status" && (args.length === 1 || (args.length === 2 && args[1] === "--json"))) {
      const current = await requireSlackConfiguration();
      const status = args[1] === "--json"
        ? await readSlackArchiveStatus(current)
        : await withSlackActivity("Checking Cloudflare archive delivery status", () => readSlackArchiveStatus(current));
      if (args[1] === "--json") {
        print({ ...status, failures: status.failures.map(failure => ({
          ...failure, next_action: slackArchiveRecoveryHint(failure.last_error_code),
        })) });
        return;
      }
      print([
        `Stage: ${status.verified ? "deliveries verified (inspect the Slack files before calling setup complete)" : status.stage === "ready" ? "configured (no archive verified since the last change)" : status.stage}`,
        `Paused: ${status.paused ? "yes" : "no"}`,
        `Sources: ${status.sources.join(", ")}`,
        `Enabled channels: ${status.enabled_channels.length ? status.enabled_channels.join(", ") : "none"}`,
        ...status.channels.map(channel => `Channel ${channel.channel_id}: ${channel.verified ? "delivery verified" : "waiting for a fresh successful delivery"}`),
        ...status.verified_sources.map(source => `Source ${source.origin}: ${source.verified ? "delivery verified" : "waiting for a fresh successful delivery"}`),
        `Worker: ${status.worker_url ?? "not deployed"}`,
        status.counts === null ? "Deliveries: unavailable until D1 is provisioned" :
          `Deliveries: ${status.counts.succeeded} succeeded, ${status.counts.failed} failed, ${status.counts.needs_review} need review, ${status.counts.transferring} transferring`,
        ...status.failures.map(failure => `Failure: ${failure.id.slice(0, 12)} in ${failure.channel_id}: ${failure.last_error_code ?? "unknown"}\nNext: ${slackArchiveRecoveryHint(failure.last_error_code)}`),
      ].join("\n"));
      return;
    }
    if ((args[0] === "sources" && (args[1] === "add" || args[1] === "remove") && args.length === 3) ||
        (args[0] === "channels" && ((args[1] === "add" && args.length >= 3) ||
          (args[1] === "remove" && args.length === 3)))) {
      const current = await requireSlackConfiguration();
      if (args[0] === "channels" && !current.app_id) throw new Error("Activate the Slack app before enabling a channel");
      const next = args[0] === "sources"
        ? args[1] === "add" ? addSlackSource(current, args[2] ?? "") : removeSlackSource(current, args[2] ?? "")
        : args[1] === "add" ? addSlackChannel(current, ...args.slice(2)) : removeSlackChannel(current, args[2] ?? "");
      if (next === current) {
        print(args[0] === "sources"
          ? "That source is already approved. No Worker update was needed."
          : "Those channels are already enabled. No Worker update was needed.");
        return;
      }
      const applied = await applySlackConfiguration(next);
      if (args[0] === "sources" && applied.worker_url) {
        const manifest = applied.app_id
          ? createSlackAppManifest(applied, applied.worker_url)
          : createSlackInitialManifest(applied, applied.worker_url);
        const path = resolve(dirname(slackStatePath), "app-manifest.json");
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        print(`Source list updated in the Worker. Apply the new Slack app manifest at ${path} in https://api.slack.com/apps before expecting the new source to work.`);
      } else {
        print(args[1] === "add"
          ? `Channels enabled in one Worker update: ${applied.enabled_channels.filter(id => !current.enabled_channels.includes(id)).join(", ")}. Invite ArtifactPass Archive to each selected channel in Slack, then post a live ArtifactPass link in each to verify. Run \`pnpm dlx artifactpass slack status\` afterward.`
          : "Channel removed from the Worker. New links there will not be archived.");
      }
      return;
    }
    if ((args[0] === "pause" || args[0] === "resume" || args[0] === "update") && args.length === 1) {
      const current = await requireSlackConfiguration();
      const next = args[0] === "update" ? current : {
        ...current, paused: args[0] === "pause", updated_at: new Date().toISOString(),
      };
      await applySlackConfiguration(next);
      print(args[0] === "pause" ? "Archiving paused. Queued but unfinished links will not transfer." :
        args[0] === "resume" ? "Archiving resumed for enabled channels." : "Archive Worker code updated without changing an ArtifactPass deployment.");
      return;
    }
    if (args[0] === "rotate" && args.length === 1) {
      const current = await requireSlackConfiguration();
      if (!current.account_id || !current.worker_name) throw new Error("Deploy the archive Worker first");
      print([
        `Open https://dash.cloudflare.com/${current.account_id}/workers-and-pages and select ${current.worker_name}.`,
        "Rotate SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET in this Worker's Secrets settings. ArtifactPass does not store either value locally.",
        "For a new Slack signing secret, update Cloudflare promptly so Slack events continue to verify. Post a fresh approved link in an enabled channel and run `pnpm dlx artifactpass slack status` to confirm delivery.",
      ].join("\n"));
      return;
    }
    if (args[0] === "uninstall" && args.length === 1) {
      const current = await requireSlackConfiguration();
      const prompt = await createTerminalPrompt();
      prompt.write([
        "Uninstall removes this add-on's customer-owned Worker, Queue, and D1 database.",
        `Worker: ${current.worker_name ?? "none"}`,
        `Queue: ${current.queue_name ?? "none"}`,
        `D1: ${current.worker_name ? `${current.worker_name}-db` : "none"}`,
        "D1 delivery history and queued jobs will be permanently deleted. ArtifactPass deployments and Slack files already uploaded are unaffected.",
      ].join("\n") + "\n");
      const approved = await promptForChoice(prompt, "Uninstall this Slack archive?", ["Keep it", "Delete these exact Cloudflare resources"]);
      if (approved === 0) {
        print("Slack archive was not changed.");
        return;
      }
      await withSlackActivity("Removing the exact Cloudflare archive resources", () =>
        uninstallSlackArchive(current, { statePath: slackStatePath, approved: true }));
      print("Cloudflare archive resources removed. Also uninstall the Slack app from https://api.slack.com/apps; Slack files already posted follow your workspace retention policy.");
      return;
    }
    if (args[0] === "activate") {
      const activationArgs = args.slice(1);
      const unexpected = activationArgs.filter((argument, index) =>
        argument !== "--team-id" && argument !== "--app-id" &&
        (index === 0 || (activationArgs[index - 1] !== "--team-id" && activationArgs[index - 1] !== "--app-id")));
      if (unexpected.length > 0) throw new Error(`Unknown Slack activation option: ${unexpected[0]}`);
      const current = await readSlackArchiveConfiguration(slackStatePath);
      if (!current) throw new Error("Run `artifactpass slack setup` first");
      const activated = await withSlackActivity("Checking Slack secrets and deploying the signed event receiver", () => activateSlackArchive(current, {
        statePath: slackStatePath,
        deploymentRoot: slackDeploymentRoot,
        teamId: value(activationArgs, "--team-id"),
        appId: value(activationArgs, "--app-id"),
      }));
      print([
        `Slack app: ${activated.app_id}. The initial manifest already contains the signed-event receiver and link domains.`,
        "In Slack, confirm Event Subscriptions is on and the request URL is verified. Do not create another app or replace its manifest.",
        "Archiving remains off until you enable a channel and invite the bot to that channel.",
      ].join("\n"));
      return;
    }
    if ((args[0] === "--help" || args[0] === "help") && args.length === 1) {
      print("ArtifactPass Slack archive\n\n  slack setup                  Print a local browser setup link; choose your own browser profile.\n  slack setup --terminal       Use the terminal-only setup flow.\n  slack activate --team-id --app-id  Connect credentials to the app created from the complete manifest.\n  slack sources add|remove     Change approved ArtifactPass origins (five-domain limit).\n  slack channels add <links...>  Opt several channels in with one Worker update.\n  slack channels remove <link> Opt one channel out.\n  slack status [--json]        Show verified deliveries and inspectable failures.\n  slack pause|resume|update    Control or update only this add-on.\n  slack rotate|uninstall       Rotate Cloudflare-held secrets or remove this add-on.\n\nArchiving remains inactive until an administrator enables a channel.");
      return;
    }
    throw new Error("Use `artifactpass slack --help` to see Slack archive commands");
  }
  if (command === "deployment") {
    const [area, action, ...deploymentArgs] = args;
    const authCommand = area === "auth" && (action === "status" || action === "disconnect");
    const doctorCommand = area === "doctor";
    if (!authCommand && !doctorCommand) {
      throw new Error("Use `deployment doctor --resume <hostname-or-id>`, `deployment auth status --resume <hostname-or-id>`, or `deployment auth disconnect --resume <hostname-or-id>`");
    }
    const commandArgs = doctorCommand ? args.slice(1) : deploymentArgs;
    jsonOutputRequested = booleanFlag(commandArgs, "--json");
    const supported = new Set(["--resume", "--json"]);
    const unexpected = commandArgs.filter((argument, index) => {
      if (supported.has(argument)) return false;
      return index === 0 || commandArgs[index - 1] !== "--resume";
    });
    if (unexpected.length > 0) throw new Error(`Unknown deployment option: ${unexpected[0]}`);
    const selector = optionalValue(commandArgs, "--resume");
    if (selector === undefined) throw new Error("deployment command requires --resume <hostname-or-id>");
    const deployment = await resolvePrivateDeploymentState(privateDeploymentStateRoot(), selector);
    if (doctorCommand) {
      const result = await runPrivateDeploymentDoctor(deployment, {
        authorizationStatus: () => privateDeploymentAuthorizationStatus(deployment),
        accessTokenForInspection: () => privateDeploymentAccessTokenForInspection(deployment),
      });
      print(jsonOutputRequested ? result : renderPrivateDeploymentDoctor(result));
      if (result.classification !== "healthy") process.exitCode = 1;
      return;
    }
    if (action === "status") {
      const status = await privateDeploymentAuthorizationStatus(deployment);
      print(jsonOutputRequested ? status : status.connected
        ? `Cloudflare authorization is connected for ${selector}. Profile: ${status.profile}. Expires: ${status.expires_at}.`
        : `Cloudflare authorization is not connected for ${selector}. Resume deployment setup to authorize.`);
      return;
    }
    const disconnected = await disconnectPrivateDeploymentAuthorization(deployment);
    print(jsonOutputRequested ? disconnected : disconnected.revoked
      ? `Cloudflare authorization for ${selector} was revoked and removed from the OS credential store.`
      : `Cloudflare authorization for ${selector} was removed locally. Cloudflare revocation did not complete.`);
    return;
  }
  if (command === "activate-public") {
    const writeApprovalManifest = optionalValue(args, "--write-approval-manifest");
    const approveManifest = optionalValue(args, "--approve-manifest");
    if ((writeApprovalManifest === undefined) === (approveManifest === undefined)) {
      throw new Error("Choose exactly one of --write-approval-manifest or --approve-manifest");
    }
    const serviceName = optionalValue(args, "--service-name");
    const result = await activatePublicArtifactPass({
      accountId: value(args, "--account-id"),
      hostname: value(args, "--hostname"),
      ...(serviceName === undefined ? {} : { serviceName }),
      ...(writeApprovalManifest === undefined ? {} : { writeApprovalManifest: resolve(writeApprovalManifest) }),
      ...(approveManifest === undefined ? {} : { approveManifest: resolve(approveManifest) }),
    }, {
      client: new CloudflareClient({ token: requiredEnvironment("CLOUDFLARE_API_TOKEN") }),
    });
    print(result);
    return;
  }
  if (command === "deploy-public") {
    const dryRun = booleanFlag(args, "--dry-run");
    const writeApprovalManifest = optionalValue(args, "--write-approval-manifest");
    const approveManifest = optionalValue(args, "--approve-manifest");
    if ([dryRun, writeApprovalManifest !== undefined, approveManifest !== undefined].filter(Boolean).length !== 1) {
      throw new Error("Choose exactly one of --dry-run, --write-approval-manifest, or --approve-manifest");
    }
    const serviceName = optionalValue(args, "--service-name");
    const result = await runDeployCommand({
      accountId: value(args, "--account-id"),
      zoneId: value(args, "--zone-id"),
      hostname: value(args, "--hostname"),
      pdfKeyId: value(args, "--pdf-key-id"),
      pdfPublicKey: value(args, "--pdf-public-key"),
      workersSubdomain: value(args, "--workers-subdomain"),
      identities: [],
      dryRun,
      productionExistingResources: booleanFlag(args, "--production-existing-resources"),
      publicAuth: {
        googleClientId: value(args, "--google-client-id"),
        googleClientSecret: requiredEnvironment("ARTIFACTPASS_GOOGLE_OAUTH_CLIENT_SECRET"),
        githubClientId: value(args, "--github-client-id"),
        githubClientSecret: requiredEnvironment("ARTIFACTPASS_GITHUB_OAUTH_CLIENT_SECRET"),
      },
      ...(serviceName === undefined ? {} : { serviceName }),
      ...(writeApprovalManifest === undefined ? {} : { writeApprovalManifest: resolve(writeApprovalManifest) }),
      ...(approveManifest === undefined ? {} : { approveManifest: resolve(approveManifest) }),
    }, {
      deploymentRoot,
      ...(process.env.CLOUDFLARE_API_TOKEN === undefined
        ? {}
        : { token: process.env.CLOUDFLARE_API_TOKEN }),
    });
    print(result);
    return;
  }
  if (command === "deploy") {
    const legacyDeploymentFlags = new Set([
      "--account-id",
      "--zone-id",
      "--hostname",
      "--service-name",
      "--workers-subdomain",
      "--pdf-key-id",
      "--pdf-public-key",
      "--allow-email",
      "--allow-domain",
      "--dry-run",
      "--write-approval-manifest",
      "--approve-manifest",
    ]);
    if (!args.some((argument) => legacyDeploymentFlags.has(argument))) {
      const wizardArguments = parsePrivateDeploymentWizardArguments(args);
      jsonOutputRequested = wizardArguments.json;
      const deploymentPrompt = process.stdin.isTTY === true && process.stderr.isTTY === true &&
        !wizardArguments.nonInteractive &&
        !wizardArguments.status && !wizardArguments.abandon
        ? await createTerminalPrompt()
        : createNonInteractiveTerminalPrompt();
      const stateRoot = privateDeploymentStateRoot();
      const persistPreparation = async (nextState: PrivateDeploymentState) => withPrivateDeploymentLock(
        stateRoot,
        nextState.deployment_id,
        async () => {
          const persisted = await writePrivateDeploymentState(
            stateRoot,
            nextState,
            nextState.last_written_by_cli_version,
          );
          activePrivateDeploymentResumeCommand = `pnpm dlx artifactpass deploy --resume ${persisted.hostname ?? persisted.deployment_id}`;
          return persisted;
        },
      );
      const finishIdentityAndRetention = async (
        state: PrivateDeploymentState,
        authorization: PrivateDeploymentAuthorizationSession,
      ) => {
        const client = new CloudflareClient({ resolveToken: authorization.resolveAccessToken });
        const identity = await runPrivateIdentitySetup(state, {
          client,
          prompt: deploymentPrompt,
          openBrowser,
        });
        if (identity.status !== "ready") {
          return {
            status: identity.status,
            state: identity.state,
            message: identity.message,
          } as const;
        }
        const identityState = await persistPreparation(identity.state);
        const retention = await runPrivateRetentionSetup(identityState, deploymentPrompt);
        return {
          status: "ready" as const,
          state: await persistPreparation(retention.state),
          message: "Private login, publisher access, and link retention are ready for deployment approval.",
        };
      };
      {
        const runWizard = (arguments_: typeof wizardArguments) => runPrivateDeploymentWizard(arguments_, {
          prompt: deploymentPrompt,
          authorizeDeployment: (state, noSaveAuthorization) => authorizePrivateDeployment(
            state,
            noSaveAuthorization,
            {
              oauth: {
                openBrowser,
                onAuthorizationUrl: (url) => {
                  deploymentPrompt.write(`Cloudflare authorization:\n${url}\n\nArtifactPass will also try to open this link. You can use any browser profile.\n`);
                },
                onBrowserOpenError: () => {
                  deploymentPrompt.write("ArtifactPass could not open the browser automatically. Open the Cloudflare authorization link printed above.\n");
                },
              },
            },
          ),
          runPrerequisites: async (state, authorization) => {
            const client = new CloudflareClient({ resolveToken: authorization.resolveAccessToken });
            const prerequisites = await runPrivateDeploymentPrerequisites(state, {
              client,
              prompt: deploymentPrompt,
              openBrowser,
              persist: persistPreparation,
            });
            if (prerequisites.status !== "ready") return prerequisites;
            const completed = await finishIdentityAndRetention(prerequisites.state, authorization);
            if (completed.status !== "ready") return completed;
            return {
              status: "ready",
              state: completed.state,
              message: "Cloudflare prerequisites, private login, publisher access, and link retention are ready for deployment approval.",
            };
          },
        });
        let result = await runWizard(wizardArguments);
        if (result.deployment !== null) {
          activePrivateDeploymentResumeCommand = `pnpm dlx artifactpass deploy --resume ${result.deployment.hostname ?? result.deployment.deployment_id}`;
        }
        try {
          setup: for (;;) {
            if (
              result.action === "retention-ready" &&
              result.deployment !== null &&
              result.authorization !== undefined
            ) {
              let approvalState = result.deployment;
              const approvalAuthorization = result.authorization;
              for (;;) {
                const deploymentResult = await withPrivateDeploymentLock(
                  stateRoot,
                  approvalState.deployment_id,
                  async () => {
                    const currentState = await resolvePrivateDeploymentState(
                      stateRoot,
                      approvalState.deployment_id,
                      approvalState.last_written_by_cli_version,
                    );
                    return runPrivateDeploymentApproval(currentState, {
                      root: stateRoot,
                      cliVersion: currentState.last_written_by_cli_version,
                      deploymentRoot,
                      prompt: deploymentPrompt,
                      authorization: approvalAuthorization,
                    });
                  },
                );
                if (deploymentResult.action === "edit-requested") {
                  if (deploymentResult.edit === "sign-in") {
          if (result.authorization.persisted === false) {
            await result.authorization.close().catch(() => {
              deploymentPrompt.write("The previous temporary Cloudflare authorization could not be fully revoked. You can continue setup safely and revoke it later in Cloudflare.\n");
            });
          }
                    result = await runWizard({
                      ...wizardArguments,
                      resume: deploymentResult.state.deployment_id,
                      createNew: false,
                      status: false,
                      abandon: false,
                    });
                    continue setup;
                  }
                  if (deploymentResult.edit === "retention") {
                    const retention = await runPrivateRetentionSetup(deploymentResult.state, deploymentPrompt);
                    approvalState = await persistPreparation(retention.state);
                    continue;
                  }
                  if (deploymentResult.edit === "audience") {
                    const completed = await finishIdentityAndRetention(deploymentResult.state, result.authorization);
                    if (completed.status !== "ready") {
                      print(`${completed.message}\nResume: pnpm dlx artifactpass deploy --resume ${completed.state.hostname ?? completed.state.deployment_id}`);
                      break setup;
                    }
                    approvalState = completed.state;
                    continue;
                  }
                  approvalState = deploymentResult.state;
                  continue;
                }
                if (jsonOutputRequested) {
                  print(deploymentResult);
                } else {
                  const lines = [deploymentResult.message, `Stage: ${deploymentResult.state.stage}`];
                  if (deploymentResult.result !== undefined) {
                    lines.push("", "Set up ArtifactPass for a teammate:", deploymentResult.result.teamCommand);
                    lines.push("", "Anyone with a live ArtifactPass link can read that artifact until it expires.");
                    lines.push("", "Change deployment settings later:", `pnpm dlx artifactpass deploy --resume ${deploymentResult.state.hostname ?? deploymentResult.state.deployment_id}`);
                  }
                  if (deploymentResult.receiptPath !== undefined) {
                    lines.push(`Deployment receipt: ${deploymentResult.receiptPath}`);
                  }
                  if (deploymentResult.action !== "complete") {
                    lines.push(`Resume: pnpm dlx artifactpass deploy --resume ${deploymentResult.state.hostname ?? deploymentResult.state.deployment_id}`);
                  }
                  print(lines.join("\n"));
                  if (deploymentResult.action === "complete") {
                    deploymentPrompt.outro?.("Private deployment complete");
                  }
                }
                break setup;
              }
            } else {
              print(jsonOutputRequested ? result : renderPrivateDeploymentWizardResult(result));
              break;
            }
          }
        } finally {
          if (result.authorization?.persisted === false) await result.authorization.close();
        }
      }
      return;
    }
    const dryRun = booleanFlag(args, "--dry-run");
    const writeApprovalManifest = optionalValue(args, "--write-approval-manifest");
    const approveManifest = optionalValue(args, "--approve-manifest");
    if ([dryRun, writeApprovalManifest !== undefined, approveManifest !== undefined].filter(Boolean).length !== 1) {
      throw new Error("Choose exactly one of --dry-run, --write-approval-manifest, or --approve-manifest");
    }
    const identities: IdentityRule[] = [
      ...values(args, "--allow-email").map((identityValue) => ({ kind: "email" as const, value: identityValue })),
      ...values(args, "--allow-domain").map((identityValue) => ({ kind: "domain" as const, value: identityValue })),
    ];
    const serviceName = optionalValue(args, "--service-name");
    const result = await runDeployCommand({
      accountId: value(args, "--account-id"),
      zoneId: value(args, "--zone-id"),
      hostname: value(args, "--hostname"),
      pdfKeyId: value(args, "--pdf-key-id"),
      pdfPublicKey: value(args, "--pdf-public-key"),
      workersSubdomain: value(args, "--workers-subdomain"),
      identities,
      dryRun,
      ...(serviceName === undefined ? {} : { serviceName }),
      ...(writeApprovalManifest === undefined ? {} : { writeApprovalManifest: resolve(writeApprovalManifest) }),
      ...(approveManifest === undefined ? {} : { approveManifest: resolve(approveManifest) }),
    }, {
      deploymentRoot,
      ...(process.env.CLOUDFLARE_API_TOKEN === undefined
        ? {}
        : { token: process.env.CLOUDFLARE_API_TOKEN }),
    });
    print(result);
    return;
  }
  if (command === "connect") {
    const connectArguments = parseConnectArguments(args);
    const savedSettings = await readSavedSettings();
    const profileName = optionalValue(args, "--profile");
    const requestedWorkspaceRoots = values(args, "--workspace-root");
    const workspaceRoots = requestedWorkspaceRoots.length > 0
      ? requestedWorkspaceRoots
      : [process.cwd()];
    const result = await connectHost({
      ...(profileName === undefined ? {} : { profileName }),
      baseUrl: resolveConnectDeploymentUrl(connectArguments, savedSettings, profileName, workspaceRoots[0]),
      workspaceRoots,
      installKnownHostAdapters: false,
      marketplaceSource: defaultMarketplace,
      openDevelopment: booleanFlag(args, "--open-development"),
    }, {
      deviceFlowDependencies: {
        openBrowser,
        onManualApprovalRequired: (url) => {
          process.stderr.write(`Open this URL to approve ArtifactPass:\n${url}\n`);
        },
      },
    });
    print({
      ...result,
      next: "ArtifactPass is connected for this project. Existing agent sessions may need to reconnect.",
    });
    return;
  }
  if (command === "profile") {
    await migrateDefaultLocalState();
    const configPath = defaultLocalConfigPath();
    const config = await readLocalBridgeSettings(configPath);
    if (args[0] === "list" && args.length === 1) {
      print({
        active_profile: config.active_profile,
        profiles: Object.entries(config.profiles).map(([name, profile]) => ({
          name,
          active: name === config.active_profile,
          base_url: profile.base_url,
          open_development: profile.open_development === true,
        })),
      });
      return;
    }
    if (args[0] === "use" && args.length === 2) {
      const next = await updateLocalBridgeSettings(configPath, (current) => {
        if (current === null) throw new Error("ArtifactPass has no saved profiles");
        return setActiveLocalBridgeProfile(current, args[1] ?? "");
      });
      print({ active_profile: next.active_profile, next: "Running agent sessions reload saved ArtifactPass configuration on their next tool call." });
      return;
    }
    throw new Error("Use `profile list` or `profile use <name>`");
  }
  if (command === "workspace") {
    await migrateDefaultLocalState();
    const configPath = defaultLocalConfigPath();
    if (args[0] === "list" && args.length === 1) {
      const config = await readLocalBridgeSettings(configPath);
      print({ workspaces: listWorkspaceAccess(config) });
      return;
    }
    if (args[0] === "remove") {
      const workspaceRoot = optionalPositional(args.slice(1), 0);
      if (workspaceRoot === undefined) {
        throw new Error("workspace remove requires an exact stored path");
      }
      if (optionalPositional(args.slice(1), 1) !== undefined) {
        throw new Error("workspace remove accepts one path");
      }
      const profile = optionalValue(args, "--profile");
      let result: ReturnType<typeof removeWorkspaceAccess> | undefined;
      const removed = await updateLocalBridgeSettings(configPath, (current) => {
        if (current === null) throw new Error("ArtifactPass has no saved workspace grants");
        result = removeWorkspaceAccess(current, workspaceRoot, profile);
        return result.settings;
      });
      if (result === undefined) throw new Error("ArtifactPass did not remove the workspace grant");
      print({
        removed: result.removed,
        remaining_covering_access: result.remaining_covering_access,
        workspace_count: listWorkspaceAccess(removed).length,
        credential_changed: false,
      });
      return;
    }
    throw new Error("Use `workspace list` or `workspace remove <path> [--profile <name>]`");
  }
  if (command === "disconnect") {
    await migrateDefaultLocalState();
    const config = await readLocalBridgeSettings(defaultLocalConfigPath());
    const profileName = optionalValue(args, "--profile");
    const baseUrl = optionalPositional(args, 0);
    if (optionalPositional(args, 1) !== undefined) throw new Error("disconnect accepts at most one deployment URL");
    const selected = selectDisconnectProfile(config, {
      ...(profileName === undefined ? {} : { profileName }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
    if (selected.settings.open_development === true) {
      print(`ArtifactPass ${selected.name} profile is local development and has no agent token.`);
      return;
    }
    await disconnectHost(selected.settings.base_url, { profileName: selected.name });
    print(`ArtifactPass ${selected.name} token revoked and removed from the OS credential store.`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
};

void main().catch((error: unknown) => {
  if (error instanceof TerminalPromptCancelledError) {
    const resumeCommand = error.resumeCommand ?? activePrivateDeploymentResumeCommand;
    process.stderr.write(resumeCommand === undefined
      ? "Setup cancelled. No changes were made.\n"
      : `Setup paused. Your progress is saved.\nResume: ${resumeCommand}\n`);
    process.exitCode = 130;
    return;
  }
  if (error instanceof ArtifactpassInstallError) {
    print(jsonOutputRequested ? error.receipt : renderInstallFailure(error));
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? redactSensitiveText(error.message) : "ArtifactPass setup failed"}\n`);
  process.exitCode = 1;
});
