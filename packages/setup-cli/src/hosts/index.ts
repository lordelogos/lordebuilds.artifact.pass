import type { ProcessRunner } from "../process";
import { runProcess } from "../process";

export type AgentHost = "codex" | "claude";

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

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export const installPluginForHosts = async (
  hosts: readonly AgentHost[],
  marketplaceSource: string,
  runner: ProcessRunner = runProcess,
): Promise<void> => {
  if (hosts.includes("codex")) {
    const marketplaces = parseJson<{ readonly marketplaces: readonly { readonly name: string }[] }>(
      (await runner("codex", ["plugin", "marketplace", "list", "--json"])).stdout,
    );
    if (!marketplaces.marketplaces.some((marketplace) => marketplace.name === "lordebuilds-artifacts")) {
      await runner("codex", ["plugin", "marketplace", "add", marketplaceSource, "--json"]);
    }
    const plugins = parseJson<{ readonly installed: readonly { readonly pluginId: string }[] }>(
      (await runner("codex", ["plugin", "list", "--json"])).stdout,
    );
    if (plugins.installed.some((plugin) => plugin.pluginId === "artifact-share@lordebuilds-artifacts")) {
      await runner("codex", ["plugin", "remove", "artifact-share@lordebuilds-artifacts"]);
    }
    await runner("codex", ["plugin", "add", "artifact-share@lordebuilds-artifacts", "--json"]);
  }

  if (hosts.includes("claude")) {
    const marketplaces = parseJson<readonly { readonly name: string }[]>(
      (await runner("claude", ["plugin", "marketplace", "list", "--json"])).stdout,
    );
    if (!marketplaces.some((marketplace) => marketplace.name === "lordebuilds-artifacts")) {
      await runner("claude", ["plugin", "marketplace", "add", marketplaceSource]);
    }
    const plugins = parseJson<readonly { readonly id: string; readonly scope?: string }[]>(
      (await runner("claude", ["plugin", "list", "--json"])).stdout,
    );
    for (const plugin of plugins.filter((candidate) => candidate.id === "artifact-share@lordebuilds-artifacts")) {
      await runner("claude", [
        "plugin", "uninstall", "artifact-share@lordebuilds-artifacts", "--scope", plugin.scope ?? "user",
      ]);
    }
    await runner("claude", [
      "plugin", "install", "artifact-share@lordebuilds-artifacts", "--scope", "user",
    ]);
  }
};
