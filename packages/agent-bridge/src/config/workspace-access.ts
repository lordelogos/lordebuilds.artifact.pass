import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import type { LocalBridgeSettings } from "./local-config";

export const containsCanonicalPath = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export const canonicalExistingPath = async (path: string): Promise<string> =>
  realpath(resolve(path));

const canonicalExistingRoot = async (path: string): Promise<string | undefined> => {
  try {
    return await canonicalExistingPath(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
};

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
  const home = await canonicalExistingPath(homedir());
  if (root === parse(root).root || root === home) {
    throw new Error("ArtifactPass workspace_root must be a project folder, not a filesystem or home directory");
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
  const resolvedRoots = (await Promise.all(roots.map(canonicalExistingRoot)))
    .filter((root): root is string => root !== undefined);
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
      root: await canonicalExistingRoot(root),
      profileName,
    }),
  ));
  const binding = bindings
    .filter((entry): entry is { readonly root: string; readonly profileName: string } =>
      entry.root !== undefined && containsCanonicalPath(entry.root, candidate))
    .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root))[0];
  if (binding !== undefined) {
    return { profileName: binding.profileName, workspaceRoot: binding.root, ambiguous: false };
  }

  const candidates = (await Promise.all(Object.entries(settings.profiles).map(
    async ([profileName, profile]) => ({
      profileName,
      roots: (await Promise.all(profile.workspace_roots.map(canonicalExistingRoot)))
        .filter((root): root is string => root !== undefined),
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
