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
import type { TerminalPrompt } from "../src/terminal-prompt";

const plainPrompt = (answer: string): { readonly prompt: TerminalPrompt; readonly question: ReturnType<typeof vi.fn> } => {
  const question = vi.fn().mockResolvedValue(answer);
  return { prompt: { question, write: vi.fn() }, question };
};

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
    const question = vi.fn(async () => {
      throw new Error("plain text prompt should not be used");
    });
    const select = vi.fn().mockResolvedValue(3);

    await expect(resolveInstallAgent(undefined, true, { question, select, write: vi.fn() }))
      .resolves.toEqual(["kimi"]);
    expect(select).toHaveBeenCalledWith("Which agent are you setting up?", [
      "Codex",
      "Claude Code",
      "Gemini CLI",
      "Kimi Code",
      "Cursor",
      "VS Code / GitHub Copilot",
      "Antigravity",
      "Other MCP client",
    ]);
    expect(question).not.toHaveBeenCalled();
  });

  it("uses --agent without prompting", async () => {
    const prompt = { question: vi.fn(), write: vi.fn() };

    expect(parseInstallAgent(["--agent", "gemini"])).toBe("gemini");
    await expect(resolveInstallAgent("vscode", true, prompt)).resolves.toEqual(["vscode"]);
    expect(prompt.question).not.toHaveBeenCalled();
  });

  it("maps every numbered agent answer and rejects an invalid answer", async () => {
    const expected = [
      ["codex"],
      ["claude"],
      ["gemini"],
      ["kimi"],
      ["cursor"],
      ["vscode"],
      ["antigravity"],
      [],
    ] as const;
    for (const [index, hosts] of expected.entries()) {
      await expect(resolveInstallAgent(undefined, true, plainPrompt(String(index + 1)).prompt))
        .resolves.toEqual(hosts);
    }
    const invalid = plainPrompt("9");
    invalid.question.mockResolvedValueOnce("9").mockResolvedValueOnce("1");
    await expect(resolveInstallAgent(undefined, true, invalid.prompt)).resolves.toEqual(["codex"]);
  });

  it("rejects unsupported agent values and requires automation to select one agent", async () => {
    expect(() => parseInstallAgent(["--agent", "both"]))
      .toThrow("--agent must be codex, claude, gemini, kimi, cursor, vscode, antigravity, or other");
    expect(() => parseInstallAgent(["--agent"]))
      .toThrow("--agent requires a value");
    expect(() => parseInstallAgent(["--agent", "codex", "--agent", "claude"]))
      .toThrow("--agent may be provided once");
    await expect(resolveInstallAgent(undefined, false, { question: vi.fn(), write: vi.fn() }))
      .rejects.toThrow("--agent is required when setup cannot ask interactively");
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
