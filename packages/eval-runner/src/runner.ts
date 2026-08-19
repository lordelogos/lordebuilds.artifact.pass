import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { evalScenarioSchema, type EvalReport } from "./contracts";
import { connectGenericMcpHost, type GenericMcpHost } from "./hosts/generic";
import { installCandidateIntoLocalEval } from "./install-lifecycle";
import {
  createLocalEvalProcessEnvironment,
  startLocalEvalEnvironment,
  type LocalEvalEnvironment,
} from "./local-environment";
import { writeEvalReport } from "./reporting";
import { outcomeWithTeardown, scoreObservedActions, verifyExactBytes, type ScoreFailure } from "./scoring";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ArtifactPass MCP returned a non-object result");
  }
  return value as Readonly<Record<string, unknown>>;
};

const publish = async (host: GenericMcpHost, path: string): Promise<string> => {
  const result = await host.callTool("publish_artifact", { path, expires_in_seconds: 900 });
  if (result.isError) throw new Error("ArtifactPass publish_artifact returned an error");
  const shareUrl = asRecord(result.value).share_url;
  if (typeof shareUrl !== "string") throw new Error("ArtifactPass publish result omitted its share URL");
  return shareUrl;
};

const reconstruct = async (host: GenericMcpHost, shareUrl: string): Promise<{
  readonly bytes: Uint8Array;
  readonly sha256: string;
}> => {
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  let resultSha256: string | undefined;
  for (let index = 0; index < 100; index += 1) {
    const result = await host.callTool("read_artifact", {
      share_url: shareUrl,
      max_bytes: 32,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.isError) throw new Error("ArtifactPass read_artifact returned an error");
    const value = asRecord(result.value);
    if (typeof value.data !== "string" || typeof value.sha256 !== "string") {
      throw new Error("ArtifactPass read result omitted source evidence");
    }
    chunks.push(Buffer.from(value.data, "base64"));
    resultSha256 = value.sha256;
    if (value.next_cursor === null) return { bytes: Buffer.concat(chunks), sha256: resultSha256 };
    if (typeof value.next_cursor !== "string") throw new Error("ArtifactPass returned an invalid cursor");
    cursor = value.next_cursor;
  }
  throw new Error("ArtifactPass cursor traversal exceeded its deterministic bound");
};

const expectRefusal = async (
  host: GenericMcpHost,
  shareUrl: string,
  failures: ScoreFailure[],
  code: string,
): Promise<void> => {
  const result = await host.callTool("read_artifact", { share_url: shareUrl });
  if (!result.isError) failures.push({ code, message: "Unsafe ArtifactPass input was accepted", safety: true });
};

const runTrial = async (
  repositoryRoot: string,
  environment: LocalEvalEnvironment,
  host: GenericMcpHost,
): Promise<{ readonly failures: readonly ScoreFailure[]; readonly scenario: ReturnType<typeof evalScenarioSchema.parse> }> => {
  const scenarioPath = join(repositoryRoot, "evals/scenarios/deterministic/generic-fidelity.json");
  const scenario = evalScenarioSchema.parse(JSON.parse(await readFile(scenarioPath, "utf8")));
  const failures: ScoreFailure[] = [];
  for (const fixture of scenario.fixtures) {
    const sourcePath = join(repositoryRoot, fixture.path);
    const targetPath = join(environment.workspaces.agentA, "fixtures", fixture.id, fixture.path.split("/").at(-1)!);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, targetPath);
    const expected = await readFile(sourcePath);
    const shareUrl = await publish(host, targetPath);
    const reconstructed = await reconstruct(host, shareUrl);
    failures.push(...verifyExactBytes({
      expected,
      actual: reconstructed.bytes,
      expectedSha256: sha256(expected),
      actualSha256: reconstructed.sha256,
    }));
  }
  await expectRefusal(host, "not-a-url", failures, "malformed_link_accepted");
  await expectRefusal(
    host,
    `https://foreign.invalid/a/${"f".repeat(43)}`,
    failures,
    "foreign_origin_accepted",
  );
  const actionScore = scoreObservedActions(scenario, host.events);
  failures.push(...actionScore.failures);
  return { failures, scenario };
};

export interface DeterministicProfileResult {
  readonly report: EvalReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export const runDeterministicProfile = async (options: {
  readonly repositoryRoot: string;
  readonly outputRoot?: string;
}): Promise<DeterministicProfileResult> => {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const runId = randomUUID();
  let environment: LocalEvalEnvironment | undefined;
  let host: GenericMcpHost | undefined;
  let teardownFailed = false;
  let failures: readonly ScoreFailure[] = [];
  let scenario = evalScenarioSchema.parse(JSON.parse(await readFile(
    join(options.repositoryRoot, "evals/scenarios/deterministic/generic-fidelity.json"),
    "utf8",
  )));
  let receiptVersion = 1;
  let trialOutcome: "pass" | "behavior_failure" | "safety_failure" | "infrastructure_failure" = "pass";
  try {
    environment = await startLocalEvalEnvironment(options.repositoryRoot);
    const install = await installCandidateIntoLocalEval({
      environment,
      repositoryRoot: options.repositoryRoot,
      agent: "agent-a",
    });
    receiptVersion = install.receipt.receipt_version;
    const mcpConfigPath = install.receipt.portable_bundle.mcp_config;
    if (mcpConfigPath === undefined) throw new Error("Deterministic eval requires portable MCP registration");
    host = await connectGenericMcpHost({
      mcpConfigPath,
      cwd: environment.workspaces.agentA,
      environment: {
        ...createLocalEvalProcessEnvironment(environment.homes.agentA),
        ARTIFACTPASS_CONFIG_PATH: join(environment.homes.agentA, ".artifactpass", "config.json"),
        ARTIFACTPASS_PDF_KEY_ID: "local-test",
        ARTIFACTPASS_PDF_PRIVATE_KEY: environment.pdfPrivateKey,
      },
    });
    const tools = await host.listTools();
    if (JSON.stringify(tools) !== JSON.stringify(["publish_artifact", "read_artifact"])) {
      throw new Error("Installed MCP bridge exposed an unexpected tool contract");
    }
    const trial = await runTrial(options.repositoryRoot, environment, host);
    failures = trial.failures;
    scenario = trial.scenario;
    if (failures.some((failure) => failure.safety)) trialOutcome = "safety_failure";
    else if (failures.length > 0) trialOutcome = "behavior_failure";
  } catch (error) {
    trialOutcome = "infrastructure_failure";
    failures = [{
      code: "deterministic_infrastructure_failure",
      message: error instanceof Error ? error.message : "Deterministic eval infrastructure failed",
      safety: false,
    }];
  } finally {
    await host?.close().catch(() => { teardownFailed = true; });
    await environment?.stop().catch(() => { teardownFailed = true; });
  }
  const combined = outcomeWithTeardown(trialOutcome, teardownFailed);
  const candidateBytes = await readFile(join(options.repositoryRoot, "plugins/artifactpass/dist/cli.mjs"));
  const completedAt = Date.now();
  const report = {
    version: 1 as const,
    run_id: runId,
    candidate: { sha256: sha256(candidateBytes) },
    receipt_version: receiptVersion,
    scenario: { id: scenario.id, version: scenario.version },
    scorer_version: scenario.scorer_version,
    host: { agent_a: "generic" as const, runtime: `node-${process.version}` },
    cohort: { profile: "deterministic" as const, trial_index: 1, trial_count: 1 },
    result: {
      version: 1 as const,
      run_id: runId,
      scenario_id: scenario.id,
      candidate_sha256: sha256(candidateBytes),
      started_at: startedAtIso,
      completed_at: new Date(completedAt).toISOString(),
      trial_outcome: combined.trialOutcome,
      outcome: combined.outcome,
      gate_class: scenario.gate_class,
      host_pair: { agent_a: "generic" as const },
      ...(trialOutcome === "infrastructure_failure"
        ? { infrastructure_code: "deterministic_runner" }
        : {}),
      teardown: teardownFailed ? "failed" as const : "passed" as const,
      observed_actions: host?.events
        .filter((event) => event.kind === "tool_call")
        .map((event) => ({ kind: "mcp_tool" as const, name: event.kind === "tool_call" ? event.toolName : "" })) ?? [],
      failures: failures.map(({ code, message }) => ({ code, message })),
    },
    latency_ms: completedAt - startedAt,
    usage: {},
    ...(trialOutcome === "infrastructure_failure"
      ? { infrastructure_classification: "deterministic_runner" }
      : {}),
  } satisfies EvalReport;
  const paths = await writeEvalReport(options.outputRoot ?? join(options.repositoryRoot, "eval-results"), report);
  return { report, ...paths };
};
