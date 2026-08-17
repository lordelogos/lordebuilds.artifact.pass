import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readLocalBridgeSettings, defaultLocalConfigPath, redactSensitiveText } from "agent-bridge";

import { runDeployCommand } from "./commands/deploy";
import { connectHost } from "./commands/connect";
import { disconnectHost } from "./commands/disconnect";
import type { IdentityRule } from "./cloudflare/deployment";
import { runDoctor } from "./doctor";
import type { AgentHost } from "./hosts";
import { openBrowser } from "./open-browser";
import { installPortableIntegration } from "./portable-integration";

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

const positional = (args: readonly string[], position: number): string => {
  const positionals = args.filter((item, index) => index === 0 || !args[index - 1]?.startsWith("--"))
    .filter((item) => !item.startsWith("--"));
  const result = positionals[position];
  if (result === undefined) throw new Error("A deployment URL is required");
  return result;
};

const print = (valueToPrint: unknown): void => {
  process.stdout.write(`${typeof valueToPrint === "string" ? valueToPrint : JSON.stringify(valueToPrint, null, 2)}\n`);
};

const help = `Artifact Share setup

Commands:
  deploy --account-id <id> --zone-id <id> --hostname <host> (--allow-email <email> | --allow-domain <domain>) [--dry-run]
  connect <base-url> [--workspace-root <path>] [--host codex|claude|both] [--no-host-install] [--marketplace <source>] [--open-development]
  disconnect [<base-url>]
  doctor

Cloudflare credentials come from CLOUDFLARE_API_TOKEN or Wrangler OAuth and are never persisted by Artifact Share.`;

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    print(help);
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor(deploymentRoot);
    print(result);
    if (!result.node || !result.wrangler || !result.deploymentAssets) process.exitCode = 1;
    return;
  }
  if (command === "deploy") {
    const identities: IdentityRule[] = [
      ...values(args, "--allow-email").map((identityValue) => ({ kind: "email" as const, value: identityValue })),
      ...values(args, "--allow-domain").map((identityValue) => ({ kind: "domain" as const, value: identityValue })),
    ];
    const result = await runDeployCommand({
      accountId: value(args, "--account-id"),
      zoneId: value(args, "--zone-id"),
      hostname: value(args, "--hostname"),
      identities,
      dryRun: args.includes("--dry-run"),
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
    const installKnownHostAdapters = !booleanFlag(args, "--no-host-install");
    const requestedHost = optionalValue(args, "--host");
    const host = requestedHost ?? "both";
    if (!new Set(["codex", "claude", "both"]).has(host)) throw new Error("--host must be codex, claude, or both");
    if (!installKnownHostAdapters && requestedHost !== undefined) {
      throw new Error("--host cannot be combined with --no-host-install");
    }
    const hosts = host === "both" ? undefined : [host as AgentHost];
    const marketplaceSource = optionalValue(args, "--marketplace") ?? defaultMarketplace;
    const portableIntegration = installKnownHostAdapters
      ? undefined
      : await installPortableIntegration({
          sourceRoot: resolve(marketplaceSource, "plugins/artifact-share"),
        });
    const result = await connectHost({
      baseUrl: positional(args, 0),
      workspaceRoots: values(args, "--workspace-root").length > 0
        ? values(args, "--workspace-root")
        : [process.cwd()],
      ...(hosts === undefined ? {} : { hosts }),
      installKnownHostAdapters,
      marketplaceSource,
      openDevelopment: booleanFlag(args, "--open-development"),
    }, {
      deviceFlowDependencies: { openBrowser },
    });
    if (!installKnownHostAdapters) {
      print({
        ...result,
        portableIntegration,
        next: "Register the MCP configuration and Agent Skills directory in your agent system.",
      });
      return;
    }
    print({ ...result, next: "Start a new agent session so the plugin and bridge reload." });
    return;
  }
  if (command === "disconnect") {
    const config = await readLocalBridgeSettings(defaultLocalConfigPath());
    await disconnectHost(args[0] ?? config.base_url);
    print("Artifact Share token revoked and removed from the OS credential store.");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? redactSensitiveText(error.message) : "Artifact Share setup failed"}\n`);
  process.exitCode = 1;
});
