import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  assertDeploymentOrigin,
  bindLocalBridgeWorkspace,
  localBridgeProfileNameForWorkspace,
  selectLocalBridgeProfile,
  setActiveLocalBridgeProfile,
  upsertLocalBridgeProfile,
  type LocalBridgeSettings,
} from "agent-bridge";

export const PUBLIC_ARTIFACTPASS_URL = "https://artifactpass.com";

export type WorkspaceConfigurationPrompt = (question: string) => Promise<string>;

export interface ResolveWorkspaceConfigurationOptions {
  readonly workspaceRoot: string;
  readonly settings: LocalBridgeSettings | null;
  readonly interactive: boolean;
  readonly prompt: WorkspaceConfigurationPrompt;
  readonly baseUrl?: string;
  readonly profileName?: string;
  readonly openDevelopment?: boolean;
}

export interface ResolvedWorkspaceConfiguration {
  readonly baseUrl: string;
  readonly profileName: string;
  readonly workspaceRoot: string;
}

export const applyWorkspaceConfiguration = (
  settings: LocalBridgeSettings | null,
  resolved: ResolvedWorkspaceConfiguration,
  openDevelopment = false,
): LocalBridgeSettings => {
  const previousProfile = settings?.profiles[resolved.profileName];
  if (
    previousProfile !== undefined &&
    new URL(previousProfile.base_url).origin !== resolved.baseUrl
  ) {
    throw new Error(
      `ArtifactPass ${resolved.profileName} already targets ${new URL(previousProfile.base_url).origin}`,
    );
  }
  const configured = bindLocalBridgeWorkspace(
    upsertLocalBridgeProfile(settings, resolved.profileName, {
      base_url: resolved.baseUrl,
      workspace_roots: [...new Set([
        ...(previousProfile?.workspace_roots ?? []),
        resolved.workspaceRoot,
      ])],
      ...(openDevelopment || previousProfile?.open_development === true
        ? { open_development: true as const }
        : {}),
      ...(previousProfile?.pdf_key_id === undefined ? {} : { pdf_key_id: previousProfile.pdf_key_id }),
      ...(previousProfile?.publication_state === "legacy" ? { publication_state: "legacy" as const } : {}),
      ...(previousProfile?.publication_state_path === undefined
        ? {}
        : { publication_state_path: previousProfile.publication_state_path }),
      credential_namespace: "artifactpass",
      ...(previousProfile?.credential_binding === "origin"
        ? { credential_binding: "origin" as const }
        : {}),
    }),
    resolved.workspaceRoot,
    resolved.profileName,
  );
  return settings === null
    ? configured
    : setActiveLocalBridgeProfile(configured, settings.active_profile);
};

const profileForOrigin = (
  origin: string,
  settings: LocalBridgeSettings | null,
): string => {
  const existing = Object.entries(settings?.profiles ?? {})
    .find(([, profile]) => profile.base_url === origin)?.[0];
  if (existing !== undefined) return existing;
  if (origin === PUBLIC_ARTIFACTPASS_URL) return "production";
  const hostname = new URL(origin).hostname.toLowerCase();
  const slug = hostname.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "deployment";
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 6);
  return `org-${slug.slice(0, 21).replace(/-$/u, "")}-${digest}`;
};

const normalizeOrigin = (baseUrl: string, openDevelopment: boolean): string =>
  assertDeploymentOrigin(new URL(baseUrl), { openDevelopment }).origin;

const currentWorkspaceSelection = (
  settings: LocalBridgeSettings | null,
  workspaceRoot: string,
): { readonly baseUrl: string; readonly profileName: string } | null => {
  if (settings === null) return null;
  const profileName = localBridgeProfileNameForWorkspace(settings, workspaceRoot);
  if (profileName === undefined) return null;
  const selected = selectLocalBridgeProfile(settings, profileName, workspaceRoot);
  return { baseUrl: selected.settings.base_url, profileName: selected.name };
};

export const resolveWorkspaceConfiguration = async (
  options: ResolveWorkspaceConfigurationOptions,
): Promise<ResolvedWorkspaceConfiguration> => {
  const workspaceRoot = resolve(options.workspaceRoot);
  const current = currentWorkspaceSelection(options.settings, workspaceRoot);
  if (options.openDevelopment === true && options.baseUrl === undefined) {
    throw new Error("--open-development requires --base-url");
  }
  if (options.baseUrl !== undefined) {
    const baseUrl = normalizeOrigin(options.baseUrl, options.openDevelopment === true);
    return {
      baseUrl,
      profileName: options.profileName ?? (
        options.openDevelopment === true ? "local" : profileForOrigin(baseUrl, options.settings)
      ),
      workspaceRoot,
    };
  }
  if (options.profileName !== undefined) {
    const selected = selectLocalBridgeProfile(options.settings ?? (() => {
      throw new Error(`Unknown ArtifactPass profile: ${options.profileName}`);
    })(), options.profileName, workspaceRoot);
    return { baseUrl: selected.settings.base_url, profileName: selected.name, workspaceRoot };
  }
  if (!options.interactive) {
    return {
      baseUrl: current?.baseUrl ?? PUBLIC_ARTIFACTPASS_URL,
      profileName: current?.profileName ?? "production",
      workspaceRoot,
    };
  }

  const currentIsOrganization = current !== null && current.baseUrl !== PUBLIC_ARTIFACTPASS_URL;
  const defaultChoice = currentIsOrganization ? "2" : "1";
  const answer = (await options.prompt(
    `Configure ArtifactPass for ${workspaceRoot}\n` +
    `  1. Public ArtifactPass (${PUBLIC_ARTIFACTPASS_URL})\n` +
    "  2. Organization deployment\n" +
    `Choose [${defaultChoice}]: `,
  )).trim() || defaultChoice;
  if (answer === "1") {
    return { baseUrl: PUBLIC_ARTIFACTPASS_URL, profileName: "production", workspaceRoot };
  }
  if (answer !== "2") throw new Error("Choose 1 or 2");

  const currentOrganizationUrl = currentIsOrganization ? current.baseUrl : undefined;
  const organizationUrl = (await options.prompt(
    `Organization deployment URL${currentOrganizationUrl === undefined ? "" : ` [${currentOrganizationUrl}]`}: `,
  )).trim() || currentOrganizationUrl;
  if (organizationUrl === undefined) throw new Error("Organization deployment URL is required");
  const baseUrl = normalizeOrigin(organizationUrl, false);
  return {
    baseUrl,
    profileName: profileForOrigin(baseUrl, options.settings),
    workspaceRoot,
  };
};
