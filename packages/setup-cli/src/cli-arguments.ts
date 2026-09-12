import { selectLocalBridgeProfile, type LocalBridgeSettings } from "agent-bridge";

import type { AgentHost } from "./hosts";

export interface ConnectArguments {
  readonly deploymentUrl?: string;
}

export const WORKSPACE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--base-url",
  "--profile",
  "--workspace-root",
]);

export const INSTALL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--agent",
  ...WORKSPACE_VALUE_OPTIONS,
]);

export type InstallAgent = AgentHost | "both";
export type InstallPrompt = (question: string) => Promise<string>;

export const parseInstallAgent = (args: readonly string[]): InstallAgent | undefined => {
  const indexes = args.flatMap((argument, index) => argument === "--agent" ? [index] : []);
  if (indexes.length > 1) throw new Error("--agent may be provided once");
  const index = indexes[0];
  if (index === undefined) return undefined;
  const selected = args[index + 1];
  if (selected === undefined || selected.startsWith("--")) throw new Error("--agent requires a value");
  if (selected !== "codex" && selected !== "claude" && selected !== "both") {
    throw new Error("--agent must be codex, claude, or both");
  }
  return selected;
};

const hostsForAgent = (agent: InstallAgent): readonly AgentHost[] =>
  agent === "both" ? ["codex", "claude"] : [agent];

export const resolveInstallAgent = async (
  requested: InstallAgent | undefined,
  interactive: boolean,
  prompt: InstallPrompt,
): Promise<readonly AgentHost[] | undefined> => {
  if (requested !== undefined) return hostsForAgent(requested);
  if (!interactive) return undefined;
  const answer = (await prompt(
    "Which agent are you installing ArtifactPass for?\n" +
    "  1. Codex\n" +
    "  2. Claude Code\n" +
    "  3. Both\n" +
    "Answer: ",
  )).trim();
  if (answer === "1") return ["codex"];
  if (answer === "2") return ["claude"];
  if (answer === "3") return ["codex", "claude"];
  throw new Error("Enter 1, 2, or 3");
};

export const INSTALL_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "--open-development",
  "--no-host-install",
  "--json",
]);

export const firstUnknownOption = (
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
): string | undefined => args.find((argument, index) =>
  !booleanOptions.has(argument) &&
  !valueOptions.has(argument) &&
  (index === 0 || !valueOptions.has(args[index - 1] ?? ""))
);

export const isInstallInvocation = (command: string | undefined): boolean =>
  command === undefined ||
  command === "install" ||
  INSTALL_VALUE_OPTIONS.has(command) ||
  INSTALL_BOOLEAN_OPTIONS.has(command);

const CONNECT_VALUE_OPTIONS = new Set([
  "--profile",
  "--workspace-root",
  "--host",
  "--marketplace",
]);

const CONNECT_BOOLEAN_OPTIONS = new Set([
  "--no-host-install",
  "--open-development",
]);

export const parseConnectArguments = (args: readonly string[]): ConnectArguments => {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (CONNECT_VALUE_OPTIONS.has(argument)) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      continue;
    }
    if (CONNECT_BOOLEAN_OPTIONS.has(argument)) continue;
    if (argument.startsWith("--")) throw new Error(`Unknown connect option: ${argument}`);
    positionals.push(argument);
  }
  if (positionals.length > 1) throw new Error("connect accepts at most one deployment URL");
  return positionals[0] === undefined ? {} : { deploymentUrl: positionals[0] };
};

export const resolveConnectDeploymentUrl = (
  parsed: ConnectArguments,
  settings: LocalBridgeSettings | null,
  requestedProfile?: string,
  currentWorkspace = process.cwd(),
): string => {
  if (parsed.deploymentUrl !== undefined) return parsed.deploymentUrl;
  if (requestedProfile !== undefined && settings?.profiles[requestedProfile] === undefined) {
    throw new Error(`Unknown ArtifactPass profile: ${requestedProfile}; provide its deployment URL to create it`);
  }
  if (settings === null) return "https://artifactpass.com";
  return selectLocalBridgeProfile(settings, requestedProfile, currentWorkspace).settings.base_url;
};
