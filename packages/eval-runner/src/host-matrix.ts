import { createHash } from "node:crypto";

import { z } from "zod";

import type { EvalScenario } from "./contracts";
import { CLAUDE_ADAPTER_COMPATIBILITY } from "./hosts/claude";
import { CODEX_ADAPTER_COMPATIBILITY } from "./hosts/codex";

export const matrixHostSchema = z.enum(["generic", "codex", "claude"]);
export type MatrixHost = z.infer<typeof matrixHostSchema>;

export const hostPairSchema = z.tuple([matrixHostSchema, matrixHostSchema]);
export type HostPair = z.infer<typeof hostPairSchema>;

export const hostMatrixConfigurationSchema = z.object({
  version: z.literal(1),
  representative_hosts: z.array(matrixHostSchema).length(3),
  ordered_pairs: z.array(hostPairSchema).min(1),
  blocking_before: z.literal("0.1.0"),
  required_cross_vendor_pairs: z.array(hostPairSchema).length(2),
}).strict();

export interface HostPosture {
  readonly host: MatrixHost;
  readonly runtimeVersion: string;
  readonly parserFixtureVersion: number;
  readonly model?: string;
  readonly authentication: "not_required" | "isolated" | "blocked";
  readonly filesystemContainment: "enforced" | "unproven";
  readonly networkContainment: "enforced" | "unproven";
  readonly approvalMode: "normal" | "bypass";
  readonly mcpTools: readonly string[];
  readonly principalId: string;
  readonly principalIsolation: "proven" | "unproven";
  readonly skillSelectionEvidence: "explicit" | "unavailable";
  readonly portableBundleSha256: string;
}

export type MatrixPairStatus =
  | "ready"
  | "authentication_blocked"
  | "containment_blocked"
  | "identity_blocked"
  | "permission_bypass_blocked"
  | "bundle_mismatch"
  | "mcp_contract_blocked"
  | "skill_observability_blocked"
  | "parser_incompatible"
  | "infrastructure_failed"
  | "skipped";

export interface MatrixDispatch {
  readonly pair: HostPair;
  readonly runtimeVersions: readonly [string, string];
  readonly scenarioId: string;
  readonly agentAPayloadSha256: string;
  readonly agentBPayloadSha256?: string;
  readonly envelope: {
    readonly volatileLinkInjected: boolean;
    readonly agentAHost: MatrixHost;
    readonly agentBHost: MatrixHost;
  };
  readonly status: MatrixPairStatus;
  readonly blocking: boolean;
  readonly reasons: readonly string[];
}

export const hashScenarioPayload = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const isCrossVendor = ([agentA, agentB]: HostPair): boolean =>
  (agentA === "codex" && agentB === "claude") ||
  (agentA === "claude" && agentB === "codex");

export const assessHostPair = (options: {
  readonly pair: HostPair;
  readonly scenario: EvalScenario;
  readonly agentA: HostPosture;
  readonly agentB: HostPosture;
  readonly expectedFixtureVersions: Readonly<Partial<Record<MatrixHost, number>>>;
  readonly expectedRuntimeVersions?: Readonly<Partial<Record<MatrixHost, string>>>;
  readonly explicitlySkipped?: boolean;
  readonly infrastructureFailure?: string;
}): MatrixDispatch => {
  const reasons: string[] = [];
  let status: MatrixPairStatus = "ready";
  if (options.explicitlySkipped === true) {
    status = "skipped";
    reasons.push("The ordered host pair was explicitly skipped");
  } else if (options.infrastructureFailure !== undefined) {
    status = "infrastructure_failed";
    reasons.push(options.infrastructureFailure);
  } else if (options.agentA.authentication === "blocked" || options.agentB.authentication === "blocked") {
    status = "authentication_blocked";
    reasons.push("An isolated host authentication plane is unavailable");
  } else if (
    options.agentA.parserFixtureVersion !== options.expectedFixtureVersions[options.agentA.host] ||
    options.agentB.parserFixtureVersion !== options.expectedFixtureVersions[options.agentB.host] ||
    (options.expectedRuntimeVersions?.[options.agentA.host] !== undefined &&
      options.agentA.runtimeVersion !== options.expectedRuntimeVersions[options.agentA.host]) ||
    (options.expectedRuntimeVersions?.[options.agentB.host] !== undefined &&
      options.agentB.runtimeVersion !== options.expectedRuntimeVersions[options.agentB.host])
  ) {
    status = "parser_incompatible";
    reasons.push("A host runtime cannot reuse the selected parser fixture contract");
  } else if (options.agentA.portableBundleSha256 !== options.agentB.portableBundleSha256) {
    status = "bundle_mismatch";
    reasons.push("Agent A and Agent B did not receive the same portable bundle digest");
  } else if (
    JSON.stringify([...options.agentA.mcpTools].sort()) !== JSON.stringify(["publish_artifact", "read_artifact"]) ||
    JSON.stringify([...options.agentB.mcpTools].sort()) !== JSON.stringify(["publish_artifact", "read_artifact"])
  ) {
    status = "mcp_contract_blocked";
    reasons.push("A host did not expose the exact portable ArtifactPass MCP tool contract");
  } else if (
    options.agentA.skillSelectionEvidence !== "explicit" ||
    options.agentB.skillSelectionEvidence !== "explicit"
  ) {
    status = "skill_observability_blocked";
    reasons.push("A host cannot emit explicit portable skill-selection evidence");
  } else if (
    options.agentA.principalIsolation !== "proven" ||
    options.agentB.principalIsolation !== "proven" ||
    options.agentA.principalId === options.agentB.principalId
  ) {
    status = "identity_blocked";
    reasons.push("Distinct Agent A and Agent B principals are not proven");
  } else if (options.agentA.approvalMode === "bypass" || options.agentB.approvalMode === "bypass") {
    status = "permission_bypass_blocked";
    reasons.push("A broad permission bypass is in use");
  } else if (
    options.agentA.filesystemContainment !== "enforced" ||
    options.agentB.filesystemContainment !== "enforced" ||
    options.agentA.networkContainment !== "enforced" ||
    options.agentB.networkContainment !== "enforced"
  ) {
    status = "containment_blocked";
    reasons.push("Filesystem or network containment is not independently enforced");
  }
  return {
    pair: options.pair,
    runtimeVersions: [options.agentA.runtimeVersion, options.agentB.runtimeVersion],
    scenarioId: options.scenario.id,
    agentAPayloadSha256: hashScenarioPayload(options.scenario.prompts.agent_a),
    ...(options.scenario.prompts.agent_b === undefined
      ? {}
      : { agentBPayloadSha256: hashScenarioPayload(options.scenario.prompts.agent_b) }),
    envelope: {
      volatileLinkInjected: options.scenario.prompts.agent_b !== undefined,
      agentAHost: options.pair[0],
      agentBHost: options.pair[1],
    },
    status,
    blocking: isCrossVendor(options.pair),
    reasons,
  };
};

export const matrixReleaseEligible = (dispatches: readonly MatrixDispatch[]): boolean => {
  const required = new Set(["codex->claude", "claude->codex"]);
  for (const dispatch of dispatches) {
    if (!dispatch.blocking) continue;
    const key = `${dispatch.pair[0]}->${dispatch.pair[1]}`;
    if (dispatch.status === "ready") required.delete(key);
  }
  return required.size === 0;
};

export const buildMatrixPreflight = (options: {
  readonly scenario: EvalScenario;
  readonly portableBundleSha256: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeVersions?: Readonly<Partial<Record<MatrixHost, string>>>;
}): readonly MatrixDispatch[] => {
  const environment = options.environment ?? process.env;
  const postures: Readonly<Record<MatrixHost, (agent: "a" | "b") => HostPosture>> = {
    generic: (agent) => ({
      host: "generic",
      runtimeVersion: "1",
      parserFixtureVersion: 1,
      authentication: "not_required",
      filesystemContainment: "enforced",
      networkContainment: "enforced",
      approvalMode: "normal",
      mcpTools: ["publish_artifact", "read_artifact"],
      principalId: `generic-${agent}`,
      principalIsolation: "proven",
      skillSelectionEvidence: "explicit",
      portableBundleSha256: options.portableBundleSha256,
    }),
    codex: () => ({
      host: "codex",
      runtimeVersion: options.runtimeVersions?.codex ?? CODEX_ADAPTER_COMPATIBILITY.testedCliVersion,
      parserFixtureVersion: 1,
      model: "gpt-5.4",
      authentication: environment.OPENAI_API_KEY === undefined ? "blocked" : "isolated",
      filesystemContainment: "enforced",
      networkContainment: "enforced",
      approvalMode: "normal",
      mcpTools: ["publish_artifact", "read_artifact"],
      principalId: "openai-api-key",
      principalIsolation: "proven",
      skillSelectionEvidence: "unavailable",
      portableBundleSha256: options.portableBundleSha256,
    }),
    claude: () => ({
      host: "claude",
      runtimeVersion: options.runtimeVersions?.claude ?? CLAUDE_ADAPTER_COMPATIBILITY.testedCliVersion,
      parserFixtureVersion: 1,
      model: "claude-sonnet-4-6",
      authentication: environment.ANTHROPIC_API_KEY === undefined ? "blocked" : "isolated",
      filesystemContainment: "enforced",
      networkContainment: "enforced",
      approvalMode: "normal",
      mcpTools: ["publish_artifact", "read_artifact"],
      principalId: "anthropic-api-key",
      principalIsolation: "proven",
      skillSelectionEvidence: "explicit",
      portableBundleSha256: options.portableBundleSha256,
    }),
  };
  const pairs: readonly HostPair[] = [
    ["generic", "generic"],
    ["codex", "codex"],
    ["claude", "claude"],
    ["codex", "claude"],
    ["claude", "codex"],
  ];
  return pairs.map((pair) => assessHostPair({
    pair,
    scenario: options.scenario,
    agentA: postures[pair[0]]("a"),
    agentB: postures[pair[1]]("b"),
    expectedFixtureVersions: { generic: 1, codex: 1, claude: 1 },
    expectedRuntimeVersions: {
      generic: "1",
      codex: CODEX_ADAPTER_COMPATIBILITY.testedCliVersion,
      claude: CLAUDE_ADAPTER_COMPATIBILITY.testedCliVersion,
    },
  }));
};
