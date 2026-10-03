import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  setActiveLocalBridgeProfile,
  upsertLocalBridgeProfile,
  type LocalBridgeSettings,
} from "agent-bridge";

export interface WorkspaceAccessEntry {
  readonly workspace_root: string;
  readonly profile: string;
  readonly origin: string;
  readonly selected_by_binding: boolean;
}

export interface RemovedWorkspaceAccess {
  readonly settings: LocalBridgeSettings;
  readonly removed: WorkspaceAccessEntry;
  readonly remaining_covering_access: readonly WorkspaceAccessEntry[];
}

const containsPath = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export const listWorkspaceAccess = (
  settings: LocalBridgeSettings,
): readonly WorkspaceAccessEntry[] => {
  const entries = new Map<string, WorkspaceAccessEntry>();
  for (const [profile, configuration] of Object.entries(settings.profiles)) {
    for (const workspaceRoot of configuration.workspace_roots) {
      const key = JSON.stringify([workspaceRoot, profile]);
      entries.set(key, {
        workspace_root: workspaceRoot,
        profile,
        origin: new URL(configuration.base_url).origin,
        selected_by_binding: settings.workspace_profiles?.[workspaceRoot] === profile,
      });
    }
  }
  for (const [workspaceRoot, profile] of Object.entries(settings.workspace_profiles ?? {})) {
    const configuration = settings.profiles[profile];
    if (configuration === undefined) continue;
    const key = JSON.stringify([workspaceRoot, profile]);
    entries.set(key, {
      workspace_root: workspaceRoot,
      profile,
      origin: new URL(configuration.base_url).origin,
      selected_by_binding: true,
    });
  }
  return [...entries.values()].sort((left, right) =>
    left.workspace_root.localeCompare(right.workspace_root) || left.profile.localeCompare(right.profile));
};

export const removeWorkspaceAccess = (
  settings: LocalBridgeSettings,
  workspaceRootValue: string,
  requestedProfile?: string,
): RemovedWorkspaceAccess => {
  const workspaceRoot = resolve(workspaceRootValue);
  const matches = listWorkspaceAccess(settings).filter((entry) =>
    entry.workspace_root === workspaceRoot &&
    (requestedProfile === undefined || entry.profile === requestedProfile));
  if (matches.length === 0) {
    throw new Error(requestedProfile === undefined
      ? `No exact ArtifactPass workspace grant exists for ${workspaceRoot}`
      : `No exact ArtifactPass workspace grant exists for ${workspaceRoot} in profile ${requestedProfile}`);
  }
  const matchingProfiles = [...new Set(matches.map((entry) => entry.profile))];
  if (requestedProfile === undefined && matchingProfiles.length > 1) {
    throw new Error(
      `Workspace ${workspaceRoot} is granted to multiple profiles (${matchingProfiles.join(", ")}); choose --profile`,
    );
  }
  const removed = matches[0];
  if (removed === undefined) throw new Error("ArtifactPass workspace grant disappeared");
  const profile = settings.profiles[removed.profile];
  if (profile === undefined) throw new Error(`Unknown ArtifactPass profile: ${removed.profile}`);
  let next = upsertLocalBridgeProfile(settings, removed.profile, {
    ...profile,
    workspace_roots: profile.workspace_roots.filter((root) => root !== workspaceRoot),
  });
  if (next.active_profile !== settings.active_profile) {
    next = setActiveLocalBridgeProfile(next, settings.active_profile);
  }
  if (next.workspace_profiles?.[workspaceRoot] === removed.profile) {
    const workspaceProfiles = { ...next.workspace_profiles };
    delete workspaceProfiles[workspaceRoot];
    if (Object.keys(workspaceProfiles).length === 0) {
      const { workspace_profiles: _removedBindings, ...withoutWorkspaceProfiles } = next;
      next = withoutWorkspaceProfiles;
    } else {
      next = { ...next, workspace_profiles: workspaceProfiles };
    }
  }
  const remainingCoveringAccess = listWorkspaceAccess(next).filter((entry) =>
    entry.workspace_root !== workspaceRoot && containsPath(entry.workspace_root, workspaceRoot));
  return { settings: next, removed, remaining_covering_access: remainingCoveringAccess };
};
