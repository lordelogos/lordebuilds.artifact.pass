import { describe, expect, it, vi } from "vitest";

import {
  isInstallInvocation,
  firstUnknownOption,
  WORKSPACE_VALUE_OPTIONS,
  parseConnectArguments,
  parseInstallAgent,
  resolveInstallAgent,
  resolveConnectDeploymentUrl,
} from "../src/cli-arguments";

describe("install CLI arguments", () => {
  it("dispatches documented install flags without an install subcommand", () => {
    expect(isInstallInvocation("--base-url")).toBe(true);
    expect(isInstallInvocation("--profile")).toBe(true);
    expect(isInstallInvocation("--workspace-root")).toBe(true);
    expect(isInstallInvocation("--agent")).toBe(true);
    expect(isInstallInvocation("--open-development")).toBe(true);
    expect(isInstallInvocation("--no-host-install")).toBe(true);
    expect(isInstallInvocation("--json")).toBe(true);
    expect(isInstallInvocation(undefined)).toBe(true);
    expect(isInstallInvocation("install")).toBe(true);
    expect(isInstallInvocation("--help")).toBe(false);
    expect(isInstallInvocation("doctor")).toBe(false);
  });

  it("asks which agent to install before setup continues", async () => {
    const prompt = vi.fn().mockResolvedValue("2");

    await expect(resolveInstallAgent(undefined, true, prompt)).resolves.toEqual(["claude"]);
    expect(prompt).toHaveBeenCalledWith(
      "Which agent are you installing ArtifactPass for?\n" +
      "  1. Codex\n" +
      "  2. Claude Code\n" +
      "  3. Both\n" +
      "Answer: ",
    );
  });

  it("uses --agent without prompting", async () => {
    const prompt = vi.fn();

    expect(parseInstallAgent(["--agent", "codex"])).toBe("codex");
    await expect(resolveInstallAgent("both", true, prompt)).resolves.toEqual(["codex", "claude"]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("maps every numbered agent answer and rejects an invalid answer", async () => {
    await expect(resolveInstallAgent(undefined, true, vi.fn().mockResolvedValue("1")))
      .resolves.toEqual(["codex"]);
    await expect(resolveInstallAgent(undefined, true, vi.fn().mockResolvedValue("3")))
      .resolves.toEqual(["codex", "claude"]);
    await expect(resolveInstallAgent(undefined, true, vi.fn().mockResolvedValue("4")))
      .rejects.toThrow("Enter 1, 2, or 3");
  });

  it("rejects unsupported agent values and preserves non-interactive auto-detection", async () => {
    expect(() => parseInstallAgent(["--agent", "gemini"]))
      .toThrow("--agent must be codex, claude, or both");
    expect(() => parseInstallAgent(["--agent"]))
      .toThrow("--agent requires a value");
    expect(() => parseInstallAgent(["--agent", "codex", "--agent", "claude"]))
      .toThrow("--agent may be provided once");
    await expect(resolveInstallAgent(undefined, false, vi.fn())).resolves.toBeUndefined();
  });

  it("keeps --agent install-only", () => {
    expect(firstUnknownOption(
      ["--agent", "codex"],
      WORKSPACE_VALUE_OPTIONS,
      new Set(["--open-development", "--json"]),
    )).toBe("--agent");
  });
});

describe("connect CLI arguments", () => {
  it("keeps a deployment URL that follows a boolean option", () => {
    expect(parseConnectArguments([
      "--no-host-install",
      "https://private.example",
    ]).deploymentUrl).toBe("https://private.example");
    expect(parseConnectArguments([
      "--open-development",
      "http://127.0.0.1:8787",
    ]).deploymentUrl).toBe("http://127.0.0.1:8787");
  });

  it("keeps a deployment URL that follows a valued option", () => {
    expect(parseConnectArguments([
      "--profile",
      "company",
      "https://artifacts.company.example",
    ]).deploymentUrl).toBe("https://artifacts.company.example");
  });

  it("accepts the deployment URL before options", () => {
    expect(parseConnectArguments([
      "https://artifacts.company.example",
      "--profile",
      "company",
    ]).deploymentUrl).toBe("https://artifacts.company.example");
  });

  it("rejects multiple deployment URLs", () => {
    expect(() => parseConnectArguments([
      "https://one.example",
      "https://two.example",
    ])).toThrow("connect accepts at most one deployment URL");
  });

  it("rejects unknown options and missing option values", () => {
    expect(() => parseConnectArguments(["--unknown"])).toThrow("Unknown connect option: --unknown");
    expect(() => parseConnectArguments(["--profile"])).toThrow("--profile requires a value");
  });

  it("uses the saved workspace deployment when the URL is omitted", () => {
    expect(resolveConnectDeploymentUrl({}, {
      version: 2,
      active_profile: "production",
      workspace_profiles: { "/workspace": "company" },
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: ["/personal"],
        },
        company: {
          base_url: "https://artifacts.company.example",
          workspace_roots: ["/workspace"],
        },
      },
    }, undefined, "/workspace/project")).toBe("https://artifacts.company.example");
  });

  it("fails closed when an explicit profile is misspelled without a URL", () => {
    expect(() => resolveConnectDeploymentUrl({}, {
      version: 2,
      active_profile: "company",
      profiles: {
        company: {
          base_url: "https://artifacts.company.example",
          workspace_roots: ["/workspace"],
        },
      },
    }, "compnay")).toThrow("Unknown ArtifactPass profile: compnay");
  });
});
