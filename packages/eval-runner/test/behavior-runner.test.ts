import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  BEHAVIOR_SCENARIO_IDS,
  runBehaviorScenario,
  scoreBehaviorScenario,
} from "../src/behavior-runner";
import { evalScenarioSchema, type NormalizedHostEvent } from "../src/contracts";
import type { EvalInstallResult } from "../src/install-lifecycle";
import type { LocalEvalEnvironment } from "../src/local-environment";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const event = <T extends Omit<NormalizedHostEvent, "version" | "host" | "sequence">>(
  sequence: number,
  value: T,
): NormalizedHostEvent => ({ version: 1, host: "claude", sequence, ...value } as NormalizedHostEvent);
const call = (sequence: number, callId: string, toolName: string, arguments_: object): NormalizedHostEvent =>
  event(sequence, { kind: "tool_call", callId, hostToolName: toolName, serverName: "artifactpass", toolName, arguments: arguments_ });
const result = (sequence: number, callId: string, value: unknown): NormalizedHostEvent =>
  event(sequence, { kind: "tool_result", callId, result: value, isError: false });

const scenario = async (id: string) => evalScenarioSchema.parse(JSON.parse(await readFile(
  join(repositoryRoot, "evals/scenarios/behavior", `${id}.json`),
  "utf8",
)));

describe("portable behavior scenario runner", () => {
  it("keeps every authored behavior scenario on the production dispatch list", async () => {
    await expect(Promise.all(BEHAVIOR_SCENARIO_IDS.map(scenario))).resolves.toHaveLength(4);
  });

  it("dispatches all four shared scorers with observable evidence", async () => {
    const bytes = Buffer.from("complete artifact");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const origin = "http://127.0.0.1:8787";
    const path = "/eval/declared-brief.md";
    const cases: Array<{
      readonly id: string;
      readonly events: readonly NormalizedHostEvent[];
      readonly expectedPath?: string;
      readonly expectedBytes?: Uint8Array;
    }> = [
      {
        id: "share-markdown",
        events: [
          event(0, { kind: "skill_selection", skillName: "share-artifact" }),
          call(1, "publish", "publish_artifact", { path, expires_in_seconds: 900 }),
          result(2, "publish", { share_url: `${origin}/a/${"a".repeat(43)}` }),
        ],
        expectedPath: path,
      },
      {
        id: "read-shared-artifact",
        events: [
          event(0, { kind: "skill_selection", skillName: "read-shared-artifact" }),
          call(1, "read", "read_artifact", { share_url: "volatile" }),
          result(2, "read", {
            data: bytes.toString("base64"),
            sha256: checksum,
            next_cursor: null,
            manifest: { mime_type: "text/markdown" },
          }),
        ],
        expectedBytes: bytes,
      },
      {
        id: "no-share-needed",
        events: [event(0, { kind: "assistant_output", text: "The brief is summarized locally." })],
      },
      {
        id: "path-and-expiry",
        events: [event(0, { kind: "assistant_output", text: "Which file path should I share?" })],
      },
    ];
    for (const item of cases) {
      expect(scoreBehaviorScenario({
        scenario: await scenario(item.id),
        events: item.events,
        ...(item.expectedPath === undefined ? {} : { expectedPath: item.expectedPath }),
        ...(item.expectedBytes === undefined ? {} : { expectedBytes: item.expectedBytes }),
        expectedOrigin: origin,
      }), item.id).toEqual([]);
    }
  });

  it("runs the ambiguous-path scenario without injecting a path and enforces its budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-behavior-runner-"));
    const environment: LocalEvalEnvironment = {
      runId: "behavior-test",
      root,
      baseUrl: new URL("http://127.0.0.1:8787"),
      stateRoot: join(root, "state"),
      configPath: join(root, "wrangler.json"),
      receiptRoot: join(root, "receipts"),
      workspaces: { agentA: join(root, "workspace-a"), agentB: join(root, "workspace-b") },
      homes: { agentA: join(root, "home-a"), agentB: join(root, "home-b") },
      controlToken: "control",
      pdfPrivateKey: "private",
      stop: vi.fn(async () => undefined),
    };
    await Promise.all([
      ...Object.values(environment.workspaces).map((path) => mkdir(path, { recursive: true })),
      ...Object.values(environment.homes).map((path) => mkdir(path, { recursive: true })),
    ]);
    const install: EvalInstallResult = {
      profileCount: 1,
      portableBundleCount: 1,
      registrationCount: 1,
      hostRestartVerified: true,
      candidateArchiveSha256: "b".repeat(64),
      receipt: {
        receipt_version: 1,
        product: "ArtifactPass",
        product_version: "test",
        operation_id: "operation",
        status: "success",
        profile: "local-eval",
        origin: environment.baseUrl.origin,
        workspace_roots: [environment.workspaces.agentA],
        adapters: [],
        portable_bundle: {
          sha256: "a".repeat(64),
          host_registration: "manual-required",
          mcp_config: join(root, "mcp.json"),
          skills_directory: join(root, "skills"),
        },
        mcp: { negotiated: true, tools: ["publish_artifact", "read_artifact"], representative_invocation: true },
        skills: { verified: true, names: ["read-shared-artifact", "share-artifact"] },
        credential: "none",
        migration: { actions: [], legacy_preserved: false },
        outcomes: [],
        restart_required: true,
        rollback: "not-required",
        receipt_path: join(root, "receipt.json"),
      },
    };
    const runHost = vi.fn(async () => ({
      events: [
        event(0, { kind: "assistant_output", text: "Which file path should I share?" }),
        event(1, { kind: "terminal", status: "succeeded" }),
      ],
      stderr: "",
      exitCode: 0,
      signal: null,
    }));

    const execution = await runBehaviorScenario({
      host: "claude",
      repositoryRoot,
      scenarioId: "path-and-expiry",
      runtimeVersion: "test",
      dependencies: {
        startEnvironment: async () => environment,
        installCandidate: async () => install,
        runHost,
        writeReport: async () => ({ jsonPath: join(root, "report.json"), markdownPath: join(root, "scorecard.md") }),
      },
    });

    expect(execution.report.result.outcome).toBe("pass");
    expect(runHost).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Share the requested file for 15 minutes. If no unique path is declared, ask one concise clarification.",
      maxSteps: 8,
      maxToolCalls: 1,
      maximumCostUsd: 0.5,
    }));
    expect(environment.stop).toHaveBeenCalledOnce();
  });
});
