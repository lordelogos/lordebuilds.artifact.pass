import { describe, expect, it, vi } from "vitest";

import {
  applyWorkspaceConfiguration,
  resolveWorkspaceConfiguration,
} from "../src/workspace-configuration";
import type { TerminalPrompt } from "../src/terminal-prompt";

const terminalPrompt = (...answers: readonly string[]): {
  readonly prompt: TerminalPrompt;
  readonly question: ReturnType<typeof vi.fn>;
} => {
  const queue = [...answers];
  const question = vi.fn(async () => queue.shift() ?? "");
  return { prompt: { question, write: vi.fn() }, question };
};

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
    const interaction = terminalPrompt();

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/company",
      settings,
      interactive: false,
      prompt: interaction.prompt,
    })).resolves.toEqual({
      baseUrl: "https://artifacts.company.example",
      profileName: "company",
      workspaceRoot: "/work/company",
    });
    expect(interaction.question).not.toHaveBeenCalled();
  });

  it("keeps explicit open development on the local profile", async () => {
    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/local",
      settings: null,
      interactive: false,
      prompt: terminalPrompt().prompt,
      baseUrl: "http://127.0.0.1:8787",
      openDevelopment: true,
    })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:8787",
      profileName: "local",
      workspaceRoot: "/work/local",
    });
  });

  it("lets an existing workspace switch back to public ArtifactPass", async () => {
    const interaction = terminalPrompt("1");

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/company",
      settings,
      interactive: true,
      prompt: interaction.prompt,
    })).resolves.toEqual({
      baseUrl: "https://artifactpass.com",
      profileName: "production",
      workspaceRoot: "/work/company",
    });
  });

  it("asks an unconfigured workspace whether its deployment is public or private", async () => {
    const select = vi.fn().mockResolvedValue(0);
    const question = vi.fn(async () => {
      throw new Error("plain text prompt should not be used");
    });
    const companyActive = { ...settings, active_profile: "company" };

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/new",
      settings: companyActive,
      interactive: true,
      prompt: { question, select, write: vi.fn() },
    })).resolves.toMatchObject({
      baseUrl: "https://artifactpass.com",
      profileName: "production",
    });
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith("Public or private deployment?", ["Public", "Private"]);
    expect(question).not.toHaveBeenCalled();
  });

  it("lets a workspace select a private deployment", async () => {
    const interaction = terminalPrompt("2", "https://sharing.example.com");

    const resolved = await resolveWorkspaceConfiguration({
      workspaceRoot: "/work/personal",
      settings,
      interactive: true,
      prompt: interaction.prompt,
    });

    expect(resolved).toMatchObject({
      baseUrl: "https://sharing.example.com",
      workspaceRoot: "/work/personal",
    });
    expect(resolved.profileName).toMatch(/^org-sharing-example-com-[a-f0-9]{6}$/u);
  });

  it("asks for a private deployment URL without suggesting the current deployment", async () => {
    const interaction = terminalPrompt("2", "");

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/company",
      settings,
      interactive: true,
      prompt: interaction.prompt,
    })).rejects.toThrow("Private deployment URL is required");
    expect(interaction.question).toHaveBeenNthCalledWith(
      1,
      "Public or private deployment?\n" +
      "1. Public\n" +
      "2. Private\n" +
      "> ",
    );
    expect(interaction.question).toHaveBeenNthCalledWith(2, "Private deployment URL\n> ");
  });

  it("retries invalid deployment choices and rejects unsafe private URLs", async () => {
    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/new",
      settings: null,
      interactive: true,
      prompt: terminalPrompt("staging", "1").prompt,
    })).resolves.toMatchObject({ profileName: "production" });

    await expect(resolveWorkspaceConfiguration({
      workspaceRoot: "/work/new",
      settings: null,
      interactive: true,
      prompt: terminalPrompt("2", "http://private.example").prompt,
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
