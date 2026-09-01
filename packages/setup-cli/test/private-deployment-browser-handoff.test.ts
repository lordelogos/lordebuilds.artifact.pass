import { describe, expect, it, vi } from "vitest";

import {
  describeBrowserHandoff,
  runBrowserHandoff,
  type BrowserHandoffPrompt,
} from "../src/private-deployment/browser-handoff";

const input = {
  title: "Enable R2 in Cloudflare",
  purpose: "ArtifactPass stores temporary artifact bytes in your R2 bucket.",
  cloudflareChange: "Cloudflare creates the R2 subscription and shows any payment terms. ArtifactPass does not choose a plan.",
  artifactpassReads: "Whether bucket listing is available for this account.",
  readiness: "Cloudflare allows ArtifactPass to list R2 buckets.",
  url: "https://dash.cloudflare.com/example/r2/overview",
};

const promptWith = (answers: readonly string[]): { prompt: BrowserHandoffPrompt; output: string[] } => {
  const queue = [...answers];
  const output: string[] = [];
  return {
    prompt: {
      question: async () => queue.shift() ?? "3",
      write: (message) => output.push(message),
    },
    output,
  };
};

describe("private deployment browser handoff", () => {
  it("explains purpose, Cloudflare mutation, ArtifactPass read, and readiness before opening", () => {
    expect(describeBrowserHandoff(input)).toContain("Why this page is needed");
    expect(describeBrowserHandoff(input)).toContain("What changes in Cloudflare");
    expect(describeBrowserHandoff(input)).toContain("What ArtifactPass reads afterward");
    expect(describeBrowserHandoff(input)).toContain("Ready when");
  });

  it("opens Cloudflare, checks readiness, and returns only the proven evidence", async () => {
    const interaction = promptWith(["1", "2"]);
    const openBrowser = vi.fn(async () => undefined);
    const result = await runBrowserHandoff(input, {
      prompt: interaction.prompt,
      openBrowser,
      check: async () => ({ status: "ready", evidence: { r2: "active" } }),
      isoNow: () => "2026-09-01T18:00:00.000Z",
    });
    expect(openBrowser).toHaveBeenCalledWith(input.url);
    expect(result).toEqual({
      status: "ready",
      evidence: { r2: "active" },
      checked_at: "2026-09-01T18:00:00.000Z",
    });
  });

  it("keeps pending work resumable and never chooses a Cloudflare plan", async () => {
    const interaction = promptWith(["2", "3"]);
    const result = await runBrowserHandoff(input, {
      prompt: interaction.prompt,
      openBrowser: async () => undefined,
      check: async () => ({ status: "pending", message: "R2 is not active yet" }),
    });
    expect(result.status).toBe("saved");
    expect(interaction.output.join("\n")).toContain("Still pending: R2 is not active yet");
  });

  it("fails with a copyable link when the browser cannot open and readiness is still pending", async () => {
    const interaction = promptWith(["1", "2"]);
    const result = await runBrowserHandoff(input, {
      prompt: interaction.prompt,
      openBrowser: async () => { throw new Error("No browser is available"); },
      check: async () => ({ status: "pending", message: "R2 is not active yet" }),
    });
    expect(result).toMatchObject({ status: "browser-open-failed" });
    expect(interaction.output.join("\n")).toContain(input.url);
  });

  it("returns permission and conflict outcomes without retrying mutations", async () => {
    const denied = await runBrowserHandoff(input, {
      prompt: promptWith(["2"]).prompt,
      openBrowser: async () => undefined,
      check: async () => ({ status: "permission-denied", message: "R2 read permission is missing" }),
    });
    expect(denied).toEqual({ status: "permission-denied", message: "R2 read permission is missing" });

    const conflict = await runBrowserHandoff(input, {
      prompt: promptWith(["2"]).prompt,
      openBrowser: async () => undefined,
      check: async () => ({ status: "conflict", message: "The hostname belongs to another Worker" }),
    });
    expect(conflict).toEqual({ status: "conflict", message: "The hostname belongs to another Worker" });
  });

  it("bounds long-running handoffs and prints an exact resume condition", async () => {
    let current = 0;
    const result = await runBrowserHandoff({ ...input, timeoutMilliseconds: 10 }, {
      prompt: promptWith(["2"]).prompt,
      openBrowser: async () => undefined,
      check: async () => {
        current = 20;
        return { status: "pending", message: "Nameservers are still pending" };
      },
      now: () => current,
    });
    expect(result).toMatchObject({ status: "timeout" });
    if (result.status !== "timeout") throw new Error("Expected the handoff to time out");
    expect(result.message).toContain(input.readiness);
  });
});
