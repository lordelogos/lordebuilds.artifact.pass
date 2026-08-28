import { selectLocalBridgeProfile, type LocalBridgeSettings } from "agent-bridge";

export interface ConnectArguments {
  readonly deploymentUrl?: string;
}

export const INSTALL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--base-url",
  "--profile",
  "--workspace-root",
]);

export const INSTALL_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "--open-development",
  "--no-host-install",
  "--json",
]);

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
