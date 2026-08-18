import type { ProcessRunner } from "../process";
import { runProcess } from "../process";

export type AgentHost = "codex" | "claude";

export const artifactpassMarketplaceId = "artifactpass";
export const artifactpassPluginId = "artifactpass@artifactpass";
export const legacyArtifactSharePluginId = "artifact-share@lordebuilds-artifacts";

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
  runner: ProcessRunner = runProcess,
): Promise<void> => {
  if (hosts.includes("codex")) {
    const marketplaceResponse = parseJson(
      (await runner("codex", ["plugin", "marketplace", "list", "--json"])).stdout,
      "Codex",
    );
    if (!isRecord(marketplaceResponse)) throw new Error("Codex returned an unexpected marketplace list");
    const marketplaces = namedEntries(marketplaceResponse.marketplaces, "Codex");
    if (marketplaces.some((marketplace) => marketplace.name === artifactpassMarketplaceId)) {
      await runner("codex", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
    }
    await runner("codex", ["plugin", "marketplace", "add", marketplaceSource, "--json"]);
    const plugins = codexPluginEntries(parseJson(
      (await runner("codex", ["plugin", "list", "--json"])).stdout,
      "Codex",
    ));
    if (plugins.some((plugin) => plugin.pluginId === artifactpassPluginId)) {
      await runner("codex", ["plugin", "remove", artifactpassPluginId]);
    }
    await runner("codex", ["plugin", "add", artifactpassPluginId, "--json"]);
  }

  if (hosts.includes("claude")) {
    const marketplaces = namedEntries(parseJson(
      (await runner("claude", ["plugin", "marketplace", "list", "--json"])).stdout,
      "Claude",
    ), "Claude");
    if (marketplaces.some((marketplace) => marketplace.name === artifactpassMarketplaceId)) {
      await runner("claude", ["plugin", "marketplace", "remove", artifactpassMarketplaceId]);
    }
    await runner("claude", ["plugin", "marketplace", "add", marketplaceSource]);
    const plugins = claudePluginEntries(parseJson(
      (await runner("claude", ["plugin", "list", "--json"])).stdout,
      "Claude",
    ));
    for (const plugin of plugins.filter((candidate) => candidate.id === artifactpassPluginId)) {
      await runner("claude", [
        "plugin", "uninstall", artifactpassPluginId, "--scope", plugin.scope ?? "user",
      ]);
    }
    await runner("claude", [
      "plugin", "install", artifactpassPluginId, "--scope", "user",
    ]);
  }
};
