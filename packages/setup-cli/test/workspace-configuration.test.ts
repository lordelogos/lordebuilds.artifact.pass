import { describe, expect, it, vi } from "vitest";

import {
  applyWorkspaceConfiguration,
  resolveWorkspaceConfiguration,
} from "../src/workspace-configuration";

const settings = {
  version: 2 as const,
  active_profile: "production",
  workspace_profiles: {
    "/work/personal": "production",
    "/work/company": "company",
  },
  profiles: {
    production: {
      base_url: "https://artifactpass.com",
      workspace_roots: ["/work/personal"],
    },
    company: {
      base_url: "https://artifacts.company.example",
      workspace_roots: ["/work/company"],
    },
  },
};

describe("workspace deployment configuration", () => {
  it("preserves the workspace deployment when no interactive terminal is available", async () => {
    const prompt = vi.fn();

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/company",
      settings,
      interactive: false,
      prompt,
    })).resolves.toEqual({
      baseUrl: "https://artifacts.company.example",
      profileName: "company",
      workspaceRoot: "/work/company",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps explicit open development on the local profile", async () => {
    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/local",
      settings: null,
      interactive: false,
      prompt: vi.fn(),
      baseUrl: "http://127.0.0.1:8787",
      openDevelopment: true,
    })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:8787",
      profileName: "local",
      workspaceRoot: "/work/local",
    });
  });

  it("lets an existing workspace switch back to public ArtifactPass", async () => {
    const prompt = vi.fn().mockResolvedValue("1");

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/company",
      settings,
      interactive: true,
      prompt,
    })).resolves.toEqual({
      baseUrl: "https://artifactpass.com",
      profileName: "production",
      workspaceRoot: "/work/company",
    });
  });

  it("asks an unconfigured workspace whether its deployment is public or private", async () => {
    const prompt = vi.fn().mockResolvedValue("1");
    const companyActive = { ...settings, active_profile: "company" };

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/new",
      settings: companyActive,
      interactive: true,
      prompt,
    })).resolves.toMatchObject({
      baseUrl: "https://artifactpass.com",
      profileName: "production",
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(
      "Public or private deployment?\n" +
      "  1. Public\n" +
      "  2. Private\n" +
      "Answer: ",
    );
  });

  it("lets a workspace select a private deployment", async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("https://sharing.example.com");

    const resolved = await resolveWorkspaceConfiguration({
      workspaceRoot: "/work/personal",
      settings,
      interactive: true,
      prompt,
    });

    expect(resolved).toMatchObject({
      baseUrl: "https://sharing.example.com",
      workspaceRoot: "/work/personal",
    });
    expect(resolved.profileName).toMatch(/^org-sharing-example-com-[a-f0-9]{6}$/u);
  });

  it("asks for a private deployment URL without suggesting the current deployment", async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("");

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/company",
      settings,
      interactive: true,
      prompt,
    })).rejects.toThrow("Private deployment URL is required");
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      "Public or private deployment?\n" +
      "  1. Public\n" +
      "  2. Private\n" +
      "Answer: ",
    );
    expect(prompt).toHaveBeenNthCalledWith(2, "Private deployment URL: ");
  });

  it("rejects invalid deployment types and URLs without looping", async () => {
    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/new",
      settings: null,
      interactive: true,
      prompt: vi.fn().mockResolvedValue("staging"),
    })).rejects.toThrow("Enter 1 or 2");

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/new",
      settings: null,
      interactive: true,
      prompt: vi.fn()
        .mockResolvedValueOnce("2")
        .mockResolvedValueOnce("http://private.example"),
    })).rejects.toThrow("credential-free HTTPS origin");
  });

  it("rebinds only the selected workspace and preserves existing profiles", () => {
    const configured = applyWorkspaceConfiguration(settings, {
      baseUrl: "https://artifactpass.com",
      profileName: "production",
      workspaceRoot: "/work/company",
    });

    expect(configured.active_profile).toBe("production");
    expect(configured.workspace_profiles).toEqual({
      "/work/personal": "production",
      "/work/company": "production",
    });
    expect(configured.profiles.company?.base_url).toBe("https://artifacts.company.example");
  });
});
