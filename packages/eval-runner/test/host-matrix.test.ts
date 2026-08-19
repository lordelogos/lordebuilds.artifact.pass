import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evalScenarioSchema } from "../src/contracts";
import {
  assessHostPair,
  buildMatrixPreflight,
  hashScenarioPayload,
  hostMatrixConfigurationSchema,
  matrixReleaseEligible,
  type HostPosture,
  type MatrixHost,
} from "../src/host-matrix";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = "a".repeat(64);
const posture = (host: MatrixHost, principalId: string): HostPosture => ({
  host,
  runtimeVersion: host === "codex" ? "0.147.0" : host === "claude" ? "2.1.197" : "1",
  parserFixtureVersion: 1,
  ...(host === "generic" ? {} : { model: host === "codex" ? "gpt-5.4" : "claude-sonnet-4-6" }),
  authentication: host === "generic" ? "not_required" : "isolated",
  filesystemContainment: "enforced",
  networkContainment: "enforced",
  approvalMode: "normal",
  mcpTools: ["publish_artifact", "read_artifact"],
  principalId,
  principalIsolation: "proven",
  skillSelectionEvidence: "explicit",
  portableBundleSha256: bundle,
});

const loadScenario = async () => evalScenarioSchema.parse(JSON.parse(await readFile(
  join(repositoryRoot, "evals/scenarios/safety/autonomous-handoff.json"),
  "utf8",
)));

describe("representative host matrix", () => {
  it("validates the five required ordered pairs", async () => {
    const configuration = hostMatrixConfigurationSchema.parse(JSON.parse(await readFile(
      join(repositoryRoot, "evals/scenarios/host-matrix.json"),
      "utf8",
    )));
    expect(configuration.ordered_pairs).toEqual([
      ["generic", "generic"],
      ["codex", "codex"],
      ["claude", "claude"],
      ["codex", "claude"],
      ["claude", "codex"],
    ]);
  });

  it("hashes byte-identical scenario-authored prompts independently of host envelopes", async () => {
    const scenario = await loadScenario();
    const dispatch = assessHostPair({
      pair: ["codex", "claude"],
      scenario,
      agentA: posture("codex", "principal-a"),
      agentB: posture("claude", "principal-b"),
      expectedFixtureVersions: { codex: 1, claude: 1 },
    });
    expect(dispatch.agentAPayloadSha256).toBe(hashScenarioPayload(scenario.prompts.agent_a));
    expect(dispatch.agentBPayloadSha256).toBe(hashScenarioPayload(scenario.prompts.agent_b!));
    expect(dispatch.envelope).toEqual({
      volatileLinkInjected: true,
      agentAHost: "codex",
      agentBHost: "claude",
    });
    expect(dispatch.runtimeVersions).toEqual(["0.147.0", "2.1.197"]);
  });

  it.each([
    ["authentication_blocked", { authentication: "blocked" }],
    ["containment_blocked", { filesystemContainment: "unproven" }],
    ["permission_bypass_blocked", { approvalMode: "bypass" }],
    ["parser_incompatible", { parserFixtureVersion: 2 }],
    ["bundle_mismatch", { portableBundleSha256: "b".repeat(64) }],
    ["mcp_contract_blocked", { mcpTools: ["publish_artifact"] }],
    ["skill_observability_blocked", { skillSelectionEvidence: "unavailable" }],
    ["identity_blocked", { principalIsolation: "unproven" }],
  ] as const)("classifies %s without turning it into model failure", async (status, override) => {
    const scenario = await loadScenario();
    const dispatch = assessHostPair({
      pair: ["codex", "claude"],
      scenario,
      agentA: posture("codex", "principal-a"),
      agentB: { ...posture("claude", "principal-b"), ...override } as HostPosture,
      expectedFixtureVersions: { codex: 1, claude: 1 },
    });
    expect(dispatch.status).toBe(status);
    expect(dispatch.blocking).toBe(true);
    expect(matrixReleaseEligible([dispatch])).toBe(false);
  });

  it("requires both cross-vendor directions to be ready", async () => {
    const scenario = await loadScenario();
    const dispatches = [
      assessHostPair({
        pair: ["codex", "claude"], scenario,
        agentA: posture("codex", "a1"), agentB: posture("claude", "b1"),
        expectedFixtureVersions: { codex: 1, claude: 1 },
      }),
      assessHostPair({
        pair: ["claude", "codex"], scenario,
        agentA: posture("claude", "a2"), agentB: posture("codex", "b2"),
        expectedFixtureVersions: { codex: 1, claude: 1 },
      }),
    ];
    expect(matrixReleaseEligible(dispatches)).toBe(true);
  });

  it("uses the generic driver's exact MCP surface as host-enforced containment", async () => {
    const scenario = await loadScenario();
    const dispatches = buildMatrixPreflight({
      scenario,
      portableBundleSha256: bundle,
      environment: {},
    });
    expect(dispatches.find((dispatch) => dispatch.pair.join("->") === "generic->generic")?.status)
      .toBe("ready");
    expect(dispatches.find((dispatch) => dispatch.pair.join("->") === "codex->claude")?.status)
      .toBe("authentication_blocked");
    expect(matrixReleaseEligible(dispatches)).toBe(false);
  });

  it("records explicit Claude Skill tool telemetry while keeping Codex unavailable fail-closed", async () => {
    const scenario = await loadScenario();
    const dispatches = buildMatrixPreflight({
      scenario,
      portableBundleSha256: bundle,
      environment: { OPENAI_API_KEY: "present", ANTHROPIC_API_KEY: "present" },
    });
    expect(dispatches.find((dispatch) => dispatch.pair.join("->") === "claude->claude")?.status)
      .toBe("identity_blocked");
    expect(dispatches.find((dispatch) => dispatch.pair.join("->") === "codex->claude")?.status)
      .toBe("skill_observability_blocked");
  });

  it("blocks a host runtime that drifts beyond its tested parser contract", async () => {
    const scenario = await loadScenario();
    const dispatches = buildMatrixPreflight({
      scenario,
      portableBundleSha256: bundle,
      environment: { OPENAI_API_KEY: "present", ANTHROPIC_API_KEY: "present" },
      runtimeVersions: { codex: "9.9.9", claude: "2.1.197" },
    });
    expect(dispatches.find((dispatch) => dispatch.pair.join("->") === "codex->claude"))
      .toMatchObject({
        status: "parser_incompatible",
        runtimeVersions: ["9.9.9", "2.1.197"],
      });
  });

  it("keeps ArtifactPass behavior and scoring policy out of host adapters", async () => {
    for (const name of ["codex.ts", "claude.ts"]) {
      const source = await readFile(join(repositoryRoot, "packages/eval-runner/src/hosts", name), "utf8");
      expect(source).not.toContain("expires_in_seconds");
      expect(source).not.toContain("scoreShareBehavior");
      expect(source).not.toContain("share-artifact");
    }
  });
});
