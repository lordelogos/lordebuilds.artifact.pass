import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { NormalizedHostEvent } from "../src/contracts";
import type { EvalInstallResult } from "../src/install-lifecycle";
import type { LocalEvalEnvironment } from "../src/local-environment";
import { modelHandoffAgentBPrompt, runModelHandoffTrial } from "../src/model-handoff";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const event = <T extends Omit<NormalizedHostEvent, "version" | "host" | "sequence">>(
  host: "codex" | "claude",
  sequence: number,
  value: T,
): NormalizedHostEvent => ({ version: 1, host, sequence, ...value } as NormalizedHostEvent);

const successfulInstall = (root: string, agent: "agent-a" | "agent-b"): EvalInstallResult => ({
  profileCount: 1,
  portableBundleCount: 1,
  receipt: {
    receipt_version: 1,
    product: "ArtifactPass",
    product_version: "test",
    operation_id: `${agent}-operation`,
    status: "success",
    profile: "local-eval",
    origin: "http://127.0.0.1:8787",
    workspace_roots: [join(root, agent, "workspace")],
    adapters: [],
    portable_bundle: {
      sha256: "a".repeat(64),
      host_registration: "manual-required",
      mcp_config: join(root, agent, "mcp.json"),
      skills_directory: join(root, agent, "skills"),
    },
    mcp: { negotiated: true, tools: ["publish_artifact", "read_artifact"], representative_invocation: true },
    skills: { verified: true, names: ["read-shared-artifact", "share-artifact"] },
    credential: "created",
    migration: { actions: [], legacy_preserved: true },
    outcomes: [],
    restart_required: true,
    rollback: "not-required",
    receipt_path: join(root, agent, "receipt.json"),
  },
});

describe("model handoff runner", () => {
  it("constructs Agent B input from the shared prompt and volatile URL only", () => {
    const prompt = modelHandoffAgentBPrompt("Read the handoff.", "http://127.0.0.1:8787/a/token");
    expect(prompt).toBe("Read the handoff.\n\nArtifactPass link: http://127.0.0.1:8787/a/token");
    expect(prompt).not.toContain("prompt-injection.md");
  });

  it("runs the ordered pair and scores only correlated MCP evidence", async () => {
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    const root = await mkdtemp(join(tmpdir(), "artifactpass-model-handoff-test-"));
    const prompts: string[] = [];
    try {
      for (const agent of ["agent-a", "agent-b"] as const) {
        await mkdir(join(root, agent, "workspace"), { recursive: true });
        await mkdir(join(root, agent, "home", ".artifactpass"), { recursive: true });
        await writeFile(join(root, agent, "home", ".artifactpass", "config.json"), "{}\n");
        await writeFile(join(root, agent, "mcp.json"), "{}\n");
      }
      const environment: LocalEvalEnvironment = {
        runId: "test-run",
        root,
        baseUrl: new URL("http://127.0.0.1:8787"),
        stateRoot: join(root, "state"),
        configPath: join(root, "config.json"),
        receiptRoot: join(root, "receipts"),
        workspaces: {
          agentA: join(root, "agent-a", "workspace"),
          agentB: join(root, "agent-b", "workspace"),
        },
        homes: {
          agentA: join(root, "agent-a", "home"),
          agentB: join(root, "agent-b", "home"),
        },
        controlToken: "control",
        pdfPrivateKey: "private",
        stop: vi.fn(async () => undefined),
      };
      const fixture = await readFile(join(repositoryRoot, "evals/fixtures/safety/prompt-injection.md"));
      const runHost = vi.fn(async (options: { readonly agent: "agent-a" | "agent-b"; readonly prompt: string }) => {
        prompts.push(options.prompt);
        if (options.agent === "agent-a") return {
          events: [
            event("codex", 0, { kind: "skill_selection", skillName: "share-artifact" }),
            event("codex", 1, {
              kind: "tool_call", callId: "publish", hostToolName: "artifactpass.publish_artifact",
              serverName: "artifactpass", toolName: "publish_artifact",
              arguments: { path: join(root, "agent-a", "workspace", "prompt-injection.md"), expires_in_seconds: 900 },
            }),
            event("codex", 2, {
              kind: "tool_result", callId: "publish", isError: false,
              result: { content: [{ type: "text", text: JSON.stringify({ share_url: "http://127.0.0.1:8787/a/token" }) }] },
            }),
            event("codex", 3, { kind: "terminal", status: "succeeded" }),
          ],
          stderr: "", exitCode: 0, signal: null,
        };
        return {
          events: [
            event("claude", 0, { kind: "skill_selection", skillName: "read-shared-artifact" }),
            event("claude", 1, {
              kind: "tool_call", callId: "read", hostToolName: "mcp__artifactpass__read_artifact",
              serverName: "artifactpass", toolName: "read_artifact", arguments: { share_url: "http://127.0.0.1:8787/a/token" },
            }),
            event("claude", 2, {
              kind: "tool_result", callId: "read", isError: false,
              result: { structuredContent: { data: fixture.toString("base64"), sha256: (await import("node:crypto")).createHash("sha256").update(fixture).digest("hex"), next_cursor: null } },
            }),
            event("claude", 3, { kind: "assistant_output", text: "Revenue increased by twelve percent." }),
            event("claude", 4, { kind: "terminal", status: "succeeded" }),
          ],
          stderr: "", exitCode: 0, signal: null,
        };
      });
      const result = await runModelHandoffTrial({
        agentA: "codex",
        agentB: "claude",
        repositoryRoot,
        profile: "smoke",
        trialIndex: 1,
        trialCount: 1,
        dependencies: {
          startEnvironment: async () => environment,
          installCandidate: async ({ agent }) => successfulInstall(root, agent),
          runHost: runHost as never,
          writeReport: async () => ({ jsonPath: "report.json", markdownPath: "scorecard.md" }),
        },
      });
      expect(result.report?.result.outcome).toBe("pass");
      expect(prompts[1]).toContain("ArtifactPass link: http://127.0.0.1:8787/a/token");
      expect(prompts[1]).not.toContain(join(root, "agent-a"));
      expect(prompts[1]).not.toContain("revenue increased by twelve percent");
      expect(environment.stop).toHaveBeenCalledOnce();
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
      if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropic;
      await rm(root, { recursive: true, force: true });
    }
  });
});
