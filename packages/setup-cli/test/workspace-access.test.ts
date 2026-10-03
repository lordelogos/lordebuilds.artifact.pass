import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { listWorkspaceAccess, removeWorkspaceAccess } from "../src/workspace-access";

const parent = resolve("/workspace");
const project = resolve("/workspace/project");
const settings = {
  version: 2 as const,
  active_profile: "production",
  workspace_profiles: {
    [parent]: "production",
    [project]: "company",
  },
  profiles: {
    production: {
      base_url: "https://artifactpass.com",
      workspace_roots: [parent],
      credential_namespace: "artifactpass" as const,
      credential_binding: "origin" as const,
    },
    company: {
      base_url: "https://artifacts.example.com",
      workspace_roots: [project],
      credential_namespace: "artifactpass" as const,
      credential_binding: "origin" as const,
    },
  },
};

describe("workspace access management", () => {
  it("lists exact grants with their deployment origin", () => {
    expect(listWorkspaceAccess(settings)).toEqual([
      {
        workspace_root: parent,
        profile: "production",
        origin: "https://artifactpass.com",
        selected_by_binding: true,
      },
      {
        workspace_root: project,
        profile: "company",
        origin: "https://artifacts.example.com",
        selected_by_binding: true,
      },
    ]);
  });

  it("removes only the exact grant and reports inherited access that remains", () => {
    const result = removeWorkspaceAccess(settings, project, "company");
    expect(result.removed.profile).toBe("company");
    expect(result.settings.profiles.company?.workspace_roots).toEqual([]);
    expect(result.settings.workspace_profiles).toEqual({ [parent]: "production" });
    expect(result.remaining_covering_access).toEqual([{
      workspace_root: parent,
      profile: "production",
      origin: "https://artifactpass.com",
      selected_by_binding: true,
    }]);
    expect(result.settings.active_profile).toBe("production");
  });

  it("requires an exact stored root", () => {
    expect(() => removeWorkspaceAccess(settings, resolve(project, "nested")))
      .toThrow(/No exact ArtifactPass workspace grant/u);
  });
});
