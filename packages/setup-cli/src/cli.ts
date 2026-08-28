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
import { connectHost } from "./commands/connect";
import { disconnectHost, selectDisconnectProfile } from "./commands/disconnect";
import {
  INSTALL_BOOLEAN_OPTIONS,
  INSTALL_VALUE_OPTIONS,
  isInstallInvocation,
  parseConnectArguments,
  resolveConnectDeploymentUrl,
} from "./cli-arguments";
import type { IdentityRule } from "./cloudflare/deployment";
import { runDoctor } from "./doctor";
import type { AgentHost } from "./hosts";
import { openBrowser } from "./open-browser";
import { installPortableIntegration } from "./portable-integration";
import { migrateDefaultLocalState } from "./local-state-migration";
import {
  ArtifactpassInstallError,
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
  install [--base-url <url>] [--profile <name>] [--workspace-root <path>] [--open-development] [--no-host-install] [--json]
  configure [--base-url <url>] [--profile <name>] [--workspace-root <path>] [--open-development] [--json]
  deploy-public --account-id <id> --zone-id <id> --hostname <host> [--service-name <name>] --workers-subdomain <name> --pdf-key-id <id> --pdf-public-key <base64> --google-client-id <id> --github-client-id <id> (--dry-run | --write-approval-manifest <path> | --approve-manifest <path>)
  deploy --account-id <id> --zone-id <id> --hostname <host> [--service-name <name>] --workers-subdomain <name> --pdf-key-id <id> --pdf-public-key <base64> (--allow-email <email> | --allow-domain <domain>) (--dry-run | --write-approval-manifest <path> | --approve-manifest <path>)
  connect [base-url] [--profile <name>] [--workspace-root <path>] [--host codex|claude|both] [--no-host-install] [--marketplace <source>] [--open-development]
  profile list
  profile use <name>
  disconnect [--profile <name>]
  doctor

Cloudflare credentials come from CLOUDFLARE_API_TOKEN or Wrangler OAuth and are never persisted by ArtifactPass.`;

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

const resolveCliWorkspaceConfiguration = async (
  args: readonly string[],
  forceInteractive: boolean,
) => {
  const baseUrl = optionalValue(args, "--base-url");
  const profileName = optionalValue(args, "--profile");
  const workspaceRoot = resolve(optionalValue(args, "--workspace-root") ?? process.cwd());
  const openDevelopment = booleanFlag(args, "--open-development");
  const settings = await readSavedSettings();
  const interactive = baseUrl === undefined && profileName === undefined &&
    process.stdin.isTTY === true && process.stderr.isTTY === true && !jsonOutputRequested;
  if (forceInteractive && !interactive && baseUrl === undefined && profileName === undefined) {
    throw new Error("ArtifactPass configure needs an interactive terminal or --base-url");
  }
  const promptSession = interactive ? workspacePrompt() : undefined;
  try {
    const resolved = await resolveWorkspaceConfiguration({
      workspaceRoot,
      settings,
      interactive,
      prompt: promptSession?.prompt ?? (async () => ""),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(profileName === undefined ? {} : { profileName }),
      openDevelopment,
    });
    return { resolved, settings, openDevelopment };
  } finally {
    promptSession?.close();
  }
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (isInstallInvocation(command)) {
    const installArgs = command === "install" ? args : process.argv.slice(2);
    jsonOutputRequested = booleanFlag(installArgs, "--json");
    const unexpected = installArgs.filter((argument, index) => {
      if (INSTALL_BOOLEAN_OPTIONS.has(argument) || INSTALL_VALUE_OPTIONS.has(argument)) return false;
      return index === 0 || !INSTALL_VALUE_OPTIONS.has(installArgs[index - 1] ?? "");
    });
    if (unexpected.length > 0) throw new Error(`Unknown install option: ${unexpected[0]}`);
    const configuration = await resolveCliWorkspaceConfiguration(installArgs, false);
    const receipt = await runArtifactpassInstall({
      marketplaceSource: defaultMarketplace,
      baseUrl: configuration.resolved.baseUrl,
      profileName: configuration.resolved.profileName,
      workspaceRoot: configuration.resolved.workspaceRoot,
      openDevelopment: configuration.openDevelopment,
      connectAfterInstall: false,
      installKnownHostAdapters: !booleanFlag(installArgs, "--no-host-install"),
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
    const supportedOptions = new Set([...INSTALL_VALUE_OPTIONS, "--open-development", "--json"]);
    const unexpected = args.filter((argument, index) => {
      if (supportedOptions.has(argument)) return false;
      return index === 0 || !INSTALL_VALUE_OPTIONS.has(args[index - 1] ?? "");
    });
    if (unexpected.length > 0) throw new Error(`Unknown configure option: ${unexpected[0]}`);
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
      sourceRoot: resolve(marketplaceSource, "plugins/artifactpass"),
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
      marketplaceSource,
      openDevelopment: booleanFlag(args, "--open-development"),
    }, {
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
    print(jsonOutputRequested ? error.receipt : renderInstallReceipt(error.receipt));
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? redactSensitiveText(error.message) : "ArtifactPass setup failed"}\n`);
  process.exitCode = 1;
});
