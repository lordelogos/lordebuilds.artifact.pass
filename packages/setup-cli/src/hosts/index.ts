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

export interface HostBridgeBinding {
  readonly configPath: string;
  readonly profileName: string;
  readonly bridgePath: string;
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

export const installPluginForHosts = async (
  hosts: readonly AgentHost[],
  marketplaceSource: string,
  binding: HostBridgeBinding,
  runner: ProcessRunner = runProcess,
): Promise<HostInstallation> => {
  const rollbackActions: Array<() => Promise<void>> = [];
  const rollback = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const action of [...rollbackActions].reverse()) {
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
    const marketplaces = namedEntries(marketplaceResponse.marketplaces, "Codex");
    const hadMarketplace = marketplaces.some((marketplace) => marketplace.name === artifactpassMarketplaceId);
    if (!hadMarketplace) {
      await runner("codex", ["plugin", "marketplace", "add", marketplaceSource, "--json"]);
      rollbackActions.push(async () => {
        await runner("codex", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
      });
    }
    const plugins = codexPluginEntries(parseJson(
      (await runner("codex", ["plugin", "list", "--json"])).stdout,
      "Codex",
    ));
    const hadPlugin = plugins.some((plugin) => plugin.pluginId === artifactpassPluginId);
    if (hadPlugin) {
      await runner("codex", ["plugin", "remove", artifactpassPluginId]);
    }
    rollbackActions.push(async () => {
      await runner("codex", ["plugin", "remove", artifactpassPluginId]);
      if (hadPlugin) await runner("codex", ["plugin", "add", artifactpassPluginId, "--json"]);
    });
    await runner("codex", ["plugin", "add", artifactpassPluginId, "--json"]);
    await runner("codex", [
      "mcp", "add", "artifactpass",
      "--env", `ARTIFACTPASS_CONFIG_PATH=${binding.configPath}`,
      "--env", `ARTIFACTPASS_PROFILE=${binding.profileName}`,
      "--", process.execPath, binding.bridgePath,
    ]);
    rollbackActions.push(async () => {
      await runner("codex", ["mcp", "remove", "artifactpass"]);
    });
    }

    if (hosts.includes("claude")) {
    const marketplaces = namedEntries(parseJson(
      (await runner("claude", ["plugin", "marketplace", "list", "--json"])).stdout,
      "Claude",
    ), "Claude");
    const hadMarketplace = marketplaces.some((marketplace) => marketplace.name === artifactpassMarketplaceId);
    if (!hadMarketplace) {
      await runner("claude", ["plugin", "marketplace", "add", marketplaceSource]);
      rollbackActions.push(async () => {
        await runner("claude", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
      });
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
    await runner("claude", [
      "mcp", "add", "--scope", "user", "artifactpass",
      "-e", `ARTIFACTPASS_CONFIG_PATH=${binding.configPath}`,
      "-e", `ARTIFACTPASS_PROFILE=${binding.profileName}`,
      "--", process.execPath, binding.bridgePath,
    ]);
    rollbackActions.push(async () => {
      await runner("claude", ["mcp", "remove", "artifactpass", "--scope", "user"]);
    });
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
