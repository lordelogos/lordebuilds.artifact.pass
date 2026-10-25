import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { readSlackArchiveConfiguration } from "../src/slack/configuration";
import { runSlackSetup } from "../src/slack/setup";
import type { ProcessRunner } from "../src/process";
import type { TerminalPrompt } from "../src/terminal-prompt";

test("setup shows prerequisites and can save before any Cloudflare mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-setup-"));
  const output: string[] = [];
  const calls: string[] = [];
  const runner: ProcessRunner = async (_command, args) => {
    calls.push(args.join(" "));
    if (args[0] === "whoami") return {
      stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "a".repeat(32), name: "Example account" }] }),
      stderr: "",
    };
    throw new Error("Setup should not create resources");
  };
  const prompt: TerminalPrompt = {
    interactive: true,
    question: async () => "",
    write: message => { output.push(message); },
    select: async (message) => message.includes("Cloudflare account") ? 0 : 1,
  };
  try {
    const result = await runSlackSetup({
      statePath: join(directory, "configuration.json"), deploymentRoot: directory,
      runner, prompt,
    });
    expect(result).toMatch(/saved|paused/i);
    expect(output.join(" ")).toMatch(/Cloudflare account/i);
    expect(output.join(" ")).toMatch(/links:read.*files:write/su);
    expect(calls).toEqual(["whoami --json"]);
    const saved = await readSlackArchiveConfiguration(join(directory, "configuration.json"));
    expect(saved?.stage).toBe("prepared");
    expect(saved?.sources).toEqual(["https://artifactpass.com"]);
    await expect(readFile(join(directory, "bootstrap-manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
