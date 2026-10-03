import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { parse, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approvedRootForPath,
  matchLocalWorkspaceProfile,
  proposedWorkspaceRoot,
} from "../src/config/workspace-access";

describe("workspace access boundaries", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rejects filesystem-wide and home-wide workspace grants", async () => {
    await expect(proposedWorkspaceRoot(parse(homedir()).root, parse(homedir()).root))
      .rejects.toThrow("project folder");
    await expect(proposedWorkspaceRoot(homedir(), homedir()))
      .rejects.toThrow("project folder");
  });

  it("ignores removed grants while retaining a valid project grant", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-boundary-"));
    temporaryRoots.push(root);
    const project = resolve(root, "project");
    const artifact = resolve(project, "handoff.md");
    await mkdir(project);
    await writeFile(artifact, "# Handoff\n");
    const missing = resolve(root, "removed-project");
    const canonicalProject = await realpath(project);

    await expect(approvedRootForPath(artifact, [missing, project])).resolves.toBe(canonicalProject);
    await expect(matchLocalWorkspaceProfile({
      version: 2,
      active_profile: "production",
      workspace_profiles: { [missing]: "production" },
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: [missing, project],
        },
      },
    }, artifact)).resolves.toEqual({
      profileName: "production",
      workspaceRoot: canonicalProject,
      ambiguous: false,
    });
  });
});
