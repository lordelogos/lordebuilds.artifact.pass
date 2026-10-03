import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { LocalBridgeSettings } from "./local-config";

export const containsCanonicalPath = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export const canonicalExistingPath = async (path: string): Promise<string> =>
  realpath(resolve(path));

export const proposedWorkspaceRoot = async (
  path: string,
  requestedRoot?: string,
): Promise<{ readonly candidate: string; readonly root: string }> => {
  if (!isAbsolute(path)) throw new Error("ArtifactPass requires an absolute artifact or workspace path");
  const candidate = await canonicalExistingPath(path);
  const candidateStat = await stat(candidate);
  const root = requestedRoot === undefined
    ? candidateStat.isDirectory() ? candidate : dirname(candidate)
    : await canonicalExistingPath(requestedRoot);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("ArtifactPass workspace_root must name a directory");
  }
  if (!containsCanonicalPath(root, candidate)) {
    throw new Error("ArtifactPass workspace_root must contain workspace_path");
  }
  return { candidate, root };
};

export const approvedRootForPath = async (
  path: string,
  roots: readonly string[],
): Promise<string | undefined> => {
  const candidate = await canonicalExistingPath(path);
  const resolvedRoots = await Promise.all(roots.map(canonicalExistingPath));
  return resolvedRoots
    .filter((root) => containsCanonicalPath(root, candidate))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
};

export interface LocalWorkspaceProfileMatch {
  readonly profileName?: string;
  readonly workspaceRoot?: string;
  readonly ambiguous: boolean;
}

export const matchLocalWorkspaceProfile = async (
  settings: LocalBridgeSettings,
  path: string,
): Promise<LocalWorkspaceProfileMatch> => {
  const candidate = await canonicalExistingPath(path);
  const bindings = await Promise.all(Object.entries(settings.workspace_profiles ?? {}).map(
    async ([root, profileName]) => ({
      root: await canonicalExistingPath(root),
      profileName,
    }),
  ));
  const binding = bindings
    .filter(({ root }) => containsCanonicalPath(root, candidate))
    .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root))[0];
  if (binding !== undefined) {
    return { profileName: binding.profileName, workspaceRoot: binding.root, ambiguous: false };
  }

  const candidates = (await Promise.all(Object.entries(settings.profiles).map(
    async ([profileName, profile]) => ({
      profileName,
      roots: await Promise.all(profile.workspace_roots.map(canonicalExistingPath)),
    }),
  )))
    .flatMap(({ profileName, roots }) => roots
      .filter((root) => containsCanonicalPath(root, candidate))
      .map((root) => ({ profileName, root })))
    .sort((left, right) => right.root.length - left.root.length || left.profileName.localeCompare(right.profileName));
  const profileNames = [...new Set(candidates.map(({ profileName }) => profileName))];
  if (profileNames.length !== 1) return { ambiguous: profileNames.length > 1 };
  const selected = candidates.find(({ profileName }) => profileName === profileNames[0]);
  return selected === undefined
    ? { ambiguous: false }
    : { profileName: selected.profileName, workspaceRoot: selected.root, ambiguous: false };
};
