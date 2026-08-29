import { access } from "node:fs/promises";
import { join } from "node:path";

import type { ProcessRunner } from "../process";
import { runProcess } from "../process";

export type AgentHost = "codex" | "claude";

export const artifactpassMarketplaceId = "artifactpass";
export const artifactpassPluginId = "artifactpass@artifactpass";
export const legacyArtifactSharePluginId = "artifact-share@lordebuilds-artifacts";

export interface HostInstallation {
  readonly hosts: readonly AgentHost[];
  rollback(): Promise<void>;
}

const canRun = async (runner: ProcessRunner, command: string): Promise<boolean> => {
  try {
    await runner(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
};

export const detectHosts = async (runner: ProcessRunner = runProcess): Promise<readonly AgentHost[]> => {
  const [codex, claude] = await Promise.all([canRun(runner, "codex"), canRun(runner, "claude")]);
  return [
    ...(codex ? ["codex" as const] : []),
    ...(claude ? ["claude" as const] : []),
  ];
};

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const namedEntries = (value: unknown, label: string): readonly { readonly name: string }[] => {
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && typeof item.name === "string")) {
    throw new Error(`${label} returned an unexpected marketplace list`);
  }
  return value as readonly { readonly name: string }[];
};

interface MarketplaceEntry {
  readonly name: string;
  readonly localSource?: string;
}

const marketplaceSourceIsReadable = async (
  source: string,
  host: AgentHost,
): Promise<boolean> => {
  const manifest = host === "claude"
    ? join(source, ".claude-plugin", "marketplace.json")
    : join(source, ".agents", "plugins", "marketplace.json");
  return access(manifest).then(() => true).catch(() => false);
};

const codexMarketplaceIsNotConfigured = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes(`marketplace \`${artifactpassMarketplaceId}\` is not configured or installed`);

const marketplaceEntries = (
  value: unknown,
  label: string,
  host: AgentHost,
): readonly MarketplaceEntry[] => {
  const entries = namedEntries(value, label);
  return entries.map((entry, index) => {
    const raw = (value as readonly Readonly<Record<string, unknown>>[])[index];
    if (raw === undefined) return entry;
    if (host === "claude") {
      return typeof raw.path === "string" ? { ...entry, localSource: raw.path } : entry;
    }
    const source = raw.marketplaceSource;
    return isRecord(source) && source.sourceType === "local" && typeof source.source === "string"
      ? { ...entry, localSource: source.source }
      : entry;
  });
};

const codexPluginEntries = (value: unknown): readonly { readonly pluginId: string }[] => {
  if (!isRecord(value) || !Array.isArray(value.installed) ||
      !value.installed.every((item) => isRecord(item) && typeof item.pluginId === "string")) {
    throw new Error("Codex returned an unexpected plugin list");
  }
  return value.installed as readonly { readonly pluginId: string }[];
};

const claudePluginEntries = (
  value: unknown,
): readonly { readonly id: string; readonly scope?: string }[] => {
  if (!Array.isArray(value) || !value.every((item) =>
    isRecord(item) && typeof item.id === "string" &&
    (item.scope === undefined || typeof item.scope === "string")
  )) {
    throw new Error("Claude returned an unexpected plugin list");
  }
  return value as readonly { readonly id: string; readonly scope?: string }[];
};

interface LegacyMcpRegistration {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

const legacyBridgePath = (value: string): boolean =>
  /(?:^|[/\\])portable-integration[/\\][a-f0-9]{64}[/\\](?:plugin|marketplace[/\\]plugins[/\\]artifactpass)[/\\]dist[/\\]cli\.mjs$/u.test(value);

const codexLegacyMcp = async (runner: ProcessRunner): Promise<LegacyMcpRegistration | null> => {
  const listed = namedEntries(parseJson(
    (await runner("codex", ["mcp", "list", "--json"])).stdout,
    "Codex MCP",
  ), "Codex MCP");
  if (!listed.some((entry) => entry.name === "artifactpass")) return null;
  const details = parseJson(
    (await runner("codex", ["mcp", "get", "artifactpass", "--json"])).stdout,
    "Codex MCP",
  );
  if (!isRecord(details) || !isRecord(details.transport)) return null;
  const transport = details.transport;
  if (
    transport.type !== "stdio" || typeof transport.command !== "string" ||
    !Array.isArray(transport.args) || !transport.args.every((argument) => typeof argument === "string") ||
    !transport.args.some(legacyBridgePath)
  ) return null;
  const environment = isRecord(transport.env)
    ? Object.fromEntries(Object.entries(transport.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ))
    : {};
  return { command: transport.command, args: transport.args as string[], environment };
};

const claudeLegacyMcp = async (runner: ProcessRunner): Promise<LegacyMcpRegistration | null> => {
  const list = (await runner("claude", ["mcp", "list"])).stdout;
  if (!list.split(/\r?\n/u).some((line) => line.startsWith("artifactpass:"))) return null;
  const details = (await runner("claude", ["mcp", "get", "artifactpass"])).stdout;
  const command = /^\s*Command:\s*(.+)$/mu.exec(details)?.[1];
  const bridgePath = /^\s*Args:\s*(.+)$/mu.exec(details)?.[1];
  if (command === undefined || bridgePath === undefined || !legacyBridgePath(bridgePath)) return null;
  const environment = Object.fromEntries([...details.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gmu)]
    .map((match) => [match[1] as string, match[2] as string]));
  return { command, args: [bridgePath], environment };
};

const environmentArguments = (
  flag: "--env" | "-e",
  environment: Readonly<Record<string, string>>,
): string[] => Object.entries(environment).flatMap(([name, value]) => [flag, `${name}=${value}`]);

export const installPluginForHosts = async (
  hosts: readonly AgentHost[],
  marketplaceSource: string,
  runner: ProcessRunner = runProcess,
): Promise<HostInstallation> => {
  const rollbackActions: Array<() => Promise<void>> = [];
  const marketplaceRollbackActions: Array<() => Promise<void>> = [];
  const rollback = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const action of [...rollbackActions, ...marketplaceRollbackActions].reverse()) {
      await action().catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) throw new AggregateError(errors, "ArtifactPass host rollback was incomplete");
  };
  try {
    if (hosts.includes("codex")) {
    const marketplaceResponse = parseJson(
      (await runner("codex", ["plugin", "marketplace", "list", "--json"])).stdout,
      "Codex",
    );
    if (!isRecord(marketplaceResponse)) throw new Error("Codex returned an unexpected marketplace list");
    const marketplaces = marketplaceEntries(marketplaceResponse.marketplaces, "Codex", "codex");
    const existingMarketplace = marketplaces.find(
      (marketplace) => marketplace.name === artifactpassMarketplaceId,
    );
    if (
      existingMarketplace === undefined ||
      (existingMarketplace.localSource !== undefined &&
        existingMarketplace.localSource !== marketplaceSource)
    ) {
      let removedConfiguredMarketplace = false;
      if (existingMarketplace !== undefined) {
        const previousMarketplaceSource = existingMarketplace.localSource as string;
        try {
          await runner("codex", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
          removedConfiguredMarketplace = true;
        } catch (error) {
          if (!codexMarketplaceIsNotConfigured(error)) throw error;
        }
        if (removedConfiguredMarketplace) {
          const previousMarketplaceIsReadable = await marketplaceSourceIsReadable(
            previousMarketplaceSource,
            "codex",
          );
          marketplaceRollbackActions.push(async () => {
            await runner("codex", ["plugin", "marketplace", "remove", artifactpassMarketplaceId])
              .catch(() => undefined);
            await runner("codex", [
              "plugin", "marketplace", "add",
              previousMarketplaceIsReadable ? previousMarketplaceSource : marketplaceSource,
              "--json",
            ]);
          });
        }
      }
      await runner("codex", ["plugin", "marketplace", "add", marketplaceSource, "--json"]);
      if (existingMarketplace === undefined || !removedConfiguredMarketplace) {
        marketplaceRollbackActions.push(async () => {
          await runner("codex", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
        });
      }
    }
    const plugins = codexPluginEntries(parseJson(
      (await runner("codex", ["plugin", "list", "--json"])).stdout,
      "Codex",
    ));
    const hadPlugin = plugins.some((plugin) => plugin.pluginId === artifactpassPluginId);
    if (hadPlugin) {
      await runner("codex", ["plugin", "remove", artifactpassPluginId]);
    }
    const legacyMcp = await codexLegacyMcp(runner);
    if (legacyMcp !== null) await runner("codex", ["mcp", "remove", "artifactpass"]);
    if (legacyMcp !== null) {
      rollbackActions.push(async () => {
        await runner("codex", [
          "mcp", "add", "artifactpass",
          ...environmentArguments("--env", legacyMcp.environment),
          "--", legacyMcp.command, ...legacyMcp.args,
        ]);
      });
    }
    rollbackActions.push(async () => {
      await runner("codex", ["plugin", "remove", artifactpassPluginId]);
      if (hadPlugin) await runner("codex", ["plugin", "add", artifactpassPluginId, "--json"]);
    });
    await runner("codex", ["plugin", "add", artifactpassPluginId, "--json"]);
    }

    if (hosts.includes("claude")) {
    const marketplaces = marketplaceEntries(parseJson(
      (await runner("claude", ["plugin", "marketplace", "list", "--json"])).stdout,
      "Claude",
    ), "Claude", "claude");
    const existingMarketplace = marketplaces.find(
      (marketplace) => marketplace.name === artifactpassMarketplaceId,
    );
    if (
      existingMarketplace === undefined ||
      (existingMarketplace.localSource !== undefined &&
        existingMarketplace.localSource !== marketplaceSource)
    ) {
      if (existingMarketplace !== undefined) {
        const previousMarketplaceSource = existingMarketplace.localSource as string;
        const previousMarketplaceIsReadable = await marketplaceSourceIsReadable(
          previousMarketplaceSource,
          "claude",
        );
        await runner("claude", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
        marketplaceRollbackActions.push(async () => {
          await runner("claude", ["plugin", "marketplace", "remove", artifactpassMarketplaceId])
            .catch(() => undefined);
          await runner("claude", [
            "plugin", "marketplace", "add",
            previousMarketplaceIsReadable ? previousMarketplaceSource : marketplaceSource,
          ]);
        });
      }
      await runner("claude", ["plugin", "marketplace", "add", marketplaceSource]);
      if (existingMarketplace === undefined) {
        marketplaceRollbackActions.push(async () => {
          await runner("claude", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
        });
      }
    }
    const plugins = claudePluginEntries(parseJson(
      (await runner("claude", ["plugin", "list", "--json"])).stdout,
      "Claude",
    ));
    const previousPlugins = plugins.filter((candidate) => candidate.id === artifactpassPluginId);
    for (const plugin of previousPlugins) {
      await runner("claude", [
        "plugin", "uninstall", artifactpassPluginId, "--scope", plugin.scope ?? "user",
      ]);
    }
    const legacyMcp = await claudeLegacyMcp(runner);
    if (legacyMcp !== null) {
      await runner("claude", ["mcp", "remove", "artifactpass", "--scope", "user"]);
      rollbackActions.push(async () => {
        await runner("claude", [
          "mcp", "add", "--scope", "user", "artifactpass",
          ...environmentArguments("-e", legacyMcp.environment),
          "--", legacyMcp.command, ...legacyMcp.args,
        ]);
      });
    }
    rollbackActions.push(async () => {
      await runner("claude", ["plugin", "uninstall", artifactpassPluginId, "--scope", "user"]);
      for (const plugin of previousPlugins) {
        await runner("claude", [
          "plugin", "install", artifactpassPluginId, "--scope", plugin.scope ?? "user",
        ]);
      }
    });
    await runner("claude", [
      "plugin", "install", artifactpassPluginId, "--scope", "user",
    ]);
    }
    return { hosts, rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "ArtifactPass host installation failed and rollback was incomplete");
    }
    throw error;
  }
};
