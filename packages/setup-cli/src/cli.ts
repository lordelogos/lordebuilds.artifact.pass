import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  defaultLocalConfigPath,
  readLocalBridgeSettings,
  redactSensitiveText,
  setActiveLocalBridgeProfile,
  writeLocalBridgeSettings,
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
import { runDoctor } from "./doctor";
import type { AgentHost } from "./hosts";
import { openBrowser } from "./open-browser";
import { installPortableIntegration } from "./portable-integration";
import { migrateDefaultLocalState } from "./local-state-migration";
import {
  parsePrivateDeploymentWizardArguments,
  renderPrivateDeploymentWizardResult,
  runPrivateDeploymentWizard,
  type PrivateDeploymentPrompt,
} from "./private-deployment/deploy-wizard";
import {
  authorizePrivateDeployment,
  disconnectPrivateDeploymentAuthorization,
  privateDeploymentAccessTokenForInspection,
  privateDeploymentAuthorizationStatus,
} from "./private-deployment/deployment-authorization";
import {
  privateDeploymentStateRoot,
  resolvePrivateDeploymentState,
  withPrivateDeploymentLock,
  writePrivateDeploymentState,
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
  type WorkspaceConfigurationPrompt,
} from "./workspace-configuration";

const deploymentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "deployment");
const defaultMarketplace = resolve(dirname(fileURLToPath(import.meta.url)), "marketplace");

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
  deploy-public --account-id <id> --zone-id <id> --hostname <host> [--service-name <name>] --workers-subdomain <name> --pdf-key-id <id> --pdf-public-key <base64> --google-client-id <id> --github-client-id <id> (--dry-run | --write-approval-manifest <path> | --approve-manifest <path>)
  deploy [--resume <hostname-or-id> | --new] [--status] [--abandon] [--no-save-authorization] [--non-interactive] [--json]
  deployment auth status --resume <hostname-or-id> [--json]
  deployment auth disconnect --resume <hostname-or-id> [--json]
  deployment doctor --resume <hostname-or-id> [--json]
  deploy --account-id <id> --zone-id <id> --hostname <host> [--service-name <name>] --workers-subdomain <name> --pdf-key-id <id> --pdf-public-key <base64> (--allow-email <email> | --allow-domain <domain>) (--dry-run | --write-approval-manifest <path> | --approve-manifest <path>)
  connect [base-url] [--profile <name>] [--workspace-root <path>] [--host codex|claude|both] [--no-host-install] [--marketplace <source>] [--open-development]
  profile list
  profile use <name>
  disconnect [--profile <name>]
  doctor

Private setup uses ArtifactPass Cloudflare OAuth and stores its refresh grant in your OS credential store. CLOUDFLARE_API_TOKEN remains an environment-only fallback.`;

const requiredEnvironment = (name: string): string => {
  const result = process.env[name];
  if (result === undefined || result.length === 0) throw new Error(`${name} is required`);
  return result;
};

let jsonOutputRequested = false;

const readSavedSettings = async () => {
  await migrateDefaultLocalState();
  return readLocalBridgeSettings(defaultLocalConfigPath()).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
};

const workspacePrompt = (): { readonly prompt: WorkspaceConfigurationPrompt; readonly close: () => void } => {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  return {
    prompt: (question) => reader.question(question),
    close: () => reader.close(),
  };
};

const privateDeploymentPrompt = (): { readonly prompt: PrivateDeploymentPrompt; readonly close: () => void } => {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  return {
    prompt: {
      interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
      question: async (message) => {
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once("SIGINT", interrupt);
        try {
          return await reader.question(message, { signal: controller.signal });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return "save";
          throw error;
        } finally {
          process.off("SIGINT", interrupt);
        }
      },
      write: (message) => process.stderr.write(message),
    },
    close: () => reader.close(),
  };
};

const resolveCliWorkspaceConfiguration = async (
  args: readonly string[],
  forceInteractive: boolean,
  providedPrompt?: WorkspaceConfigurationPrompt,
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
  const promptSession = interactive && providedPrompt === undefined ? workspacePrompt() : undefined;
  try {
    const resolved = await resolveWorkspaceConfiguration({
      workspaceRoot,
      settings,
      interactive,
      prompt: providedPrompt ?? promptSession?.prompt ?? (async () => ""),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(profileName === undefined ? {} : { profileName }),
      openDevelopment,
    });
    return { resolved, settings, openDevelopment };
  } finally {
    promptSession?.close();
  }
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
  const promptSession = agentInteractive || workspaceInteractive ? workspacePrompt() : undefined;
  try {
    const hosts = installKnownHostAdapters
      ? await resolveInstallAgent(requestedAgent, agentInteractive, promptSession?.prompt ?? (async () => ""))
      : undefined;
    const workspace = await resolveCliWorkspaceConfiguration(args, false, promptSession?.prompt);
    return { ...workspace, hosts };
  } finally {
    promptSession?.close();
  }
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
    print(jsonOutputRequested ? receipt : renderInstallReceipt(receipt));
    return;
  }
  if (command === "configure") {
    jsonOutputRequested = booleanFlag(args, "--json");
    const configureBooleanOptions = new Set(["--open-development", "--json"]);
    const unexpected = firstUnknownOption(args, WORKSPACE_VALUE_OPTIONS, configureBooleanOptions);
    if (unexpected !== undefined) throw new Error(`Unknown configure option: ${unexpected}`);
    const configuration = await resolveCliWorkspaceConfiguration(args, true);
    const updated = applyWorkspaceConfiguration(
      configuration.settings,
      configuration.resolved,
      configuration.openDevelopment,
    );
    await writeLocalBridgeSettings(defaultLocalConfigPath(), updated);
    print(jsonOutputRequested ? {
      profile: configuration.resolved.profileName,
      origin: configuration.resolved.baseUrl,
      workspace_root: configuration.resolved.workspaceRoot,
      connection_status: "not-checked",
    } : `ArtifactPass now uses ${configuration.resolved.baseUrl} for ${configuration.resolved.workspaceRoot}. Start a new agent session; if this deployment is not connected, connect from the agent when you first use it.`);
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
      const promptSession = privateDeploymentPrompt();
      try {
        const result = await runPrivateDeploymentWizard(wizardArguments, {
          prompt: promptSession.prompt,
          authorizeDeployment: (state, noSaveAuthorization) => authorizePrivateDeployment(
            state,
            noSaveAuthorization,
            {
              oauth: {
                openBrowser,
                onManualOpen: (url) => {
                  process.stderr.write(`Open this Cloudflare authorization URL:\n${url}\n`);
                },
              },
            },
          ),
          runPrerequisites: async (state, authorization) => {
            const client = new CloudflareClient({ resolveToken: authorization.resolveAccessToken });
            const stateRoot = privateDeploymentStateRoot();
            const persistPreparation = async (nextState: typeof state) => withPrivateDeploymentLock(
              stateRoot,
              nextState.deployment_id,
              async () => writePrivateDeploymentState(
                stateRoot,
                nextState,
                nextState.last_written_by_cli_version,
              ),
            );
            const prerequisites = await runPrivateDeploymentPrerequisites(state, {
              client,
              prompt: promptSession.prompt,
              openBrowser,
              persist: persistPreparation,
            });
            if (prerequisites.status !== "ready") return prerequisites;
            const identity = await runPrivateIdentitySetup(prerequisites.state, {
              client,
              prompt: promptSession.prompt,
              openBrowser,
            });
            if (identity.status !== "ready") {
              return {
                status: identity.status,
                state: identity.state,
                message: identity.message,
              };
            }
            const identityState = await persistPreparation(identity.state);
            const retention = await runPrivateRetentionSetup(identityState, promptSession.prompt);
            const retentionState = await persistPreparation(retention.state);
            return {
              status: "ready",
              state: retentionState,
              message: "Cloudflare prerequisites, private login, publisher access, and link retention are ready for deployment approval.",
            };
          },
        });
        try {
          if (
            result.action === "retention-ready" &&
            result.deployment !== null &&
            result.authorization !== undefined
          ) {
            const deploymentResult = await runPrivateDeploymentApproval(result.deployment, {
              root: privateDeploymentStateRoot(),
              cliVersion: result.deployment.last_written_by_cli_version,
              deploymentRoot,
              prompt: promptSession.prompt,
              authorization: result.authorization,
            });
            if (jsonOutputRequested) {
              print(deploymentResult);
            } else {
              const lines = [deploymentResult.message, `Stage: ${deploymentResult.state.stage}`];
              if (deploymentResult.result !== undefined) {
                lines.push("", "Set up ArtifactPass for a teammate:", deploymentResult.result.teamCommand);
                lines.push("", "Anyone with a live ArtifactPass link can read that artifact until it expires.");
              }
              if (deploymentResult.receiptPath !== undefined) {
                lines.push(`Deployment receipt: ${deploymentResult.receiptPath}`);
              }
              if (deploymentResult.action !== "complete") {
                lines.push(`Resume: pnpm dlx artifactpass deploy --resume ${deploymentResult.state.hostname ?? deploymentResult.state.deployment_id}`);
              }
              print(lines.join("\n"));
            }
          } else {
            print(jsonOutputRequested ? result : renderPrivateDeploymentWizardResult(result));
          }
        } finally {
          if (result.authorization?.persisted === false) await result.authorization.close();
        }
      } finally {
        promptSession.close();
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
    const installKnownHostAdapters = !booleanFlag(args, "--no-host-install");
    const requestedHost = optionalValue(args, "--host");
    const host = requestedHost ?? "both";
    if (!new Set(["codex", "claude", "both"]).has(host)) throw new Error("--host must be codex, claude, or both");
    if (!installKnownHostAdapters && requestedHost !== undefined) {
      throw new Error("--host cannot be combined with --no-host-install");
    }
    const hosts = host === "both" ? undefined : [host as AgentHost];
    const marketplaceSource = optionalValue(args, "--marketplace") ?? defaultMarketplace;
    const portableIntegration = await installPortableIntegration({
      marketplaceSource,
    });
    const profileName = optionalValue(args, "--profile");
    const requestedWorkspaceRoots = values(args, "--workspace-root");
    const workspaceRoots = requestedWorkspaceRoots.length > 0
      ? requestedWorkspaceRoots
      : [process.cwd()];
    const result = await connectHost({
      ...(profileName === undefined ? {} : { profileName }),
      baseUrl: resolveConnectDeploymentUrl(connectArguments, savedSettings, profileName, workspaceRoots[0]),
      workspaceRoots,
      ...(hosts === undefined ? {} : { hosts }),
      installKnownHostAdapters,
      marketplaceSource: portableIntegration.marketplaceDirectory,
      openDevelopment: booleanFlag(args, "--open-development"),
    }, {
      installPortable: async () => portableIntegration,
      deviceFlowDependencies: {
        openBrowser,
        onManualApprovalRequired: (url) => {
          process.stderr.write(`Open this URL to approve ArtifactPass:\n${url}\n`);
        },
      },
    });
    if (!installKnownHostAdapters || result.portableIntegration !== undefined) {
      print({
        ...result,
        portableIntegration: result.portableIntegration ?? portableIntegration,
        next: "Register the MCP configuration and Agent Skills directory in your agent system.",
      });
      return;
    }
    print({ ...result, next: "Start a new agent session so the plugin and bridge reload." });
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
      const next = setActiveLocalBridgeProfile(config, args[1] ?? "");
      await writeLocalBridgeSettings(configPath, next);
      print({ active_profile: next.active_profile, next: "Start a new agent session so the bridge reloads." });
      return;
    }
    throw new Error("Use `profile list` or `profile use <name>`");
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
  if (error instanceof ArtifactpassInstallError) {
    print(jsonOutputRequested ? error.receipt : renderInstallFailure(error));
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? redactSensitiveText(error.message) : "ArtifactPass setup failed"}\n`);
  process.exitCode = 1;
});
