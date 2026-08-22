import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { evalScenarioSchema, type EvalReport } from "./contracts";
import { candidateDigest } from "./candidate-digest";
import { connectGenericMcpHost, type GenericMcpHost } from "./hosts/generic";
import { runGenericTransportGates } from "./handoff-runner";
import { installCandidateIntoLocalEval } from "./install-lifecycle";
import {
  createLocalEvalProcessEnvironment,
  startLocalEvalEnvironment,
  type LocalEvalEnvironment,
} from "./local-environment";
import { writeEvalReport } from "./reporting";
import { outcomeWithTeardown, scoreObservedActions, verifyExactBytes, type ScoreFailure } from "./scoring";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// Local control endpoints run in the eval Worker and should answer promptly; bound them so a
// wedged Worker is reported as infrastructure failure instead of hanging the deterministic run.
export const LOCAL_CONTROL_REQUEST_TIMEOUT_MS = 5_000;

const requestLocalControl = (
  environment: LocalEvalEnvironment,
  path: "/__local-test/time" | "/__local-test/revoke" | "/__local-test/cleanup" | "/__local-test/fault",
  body: string,
): Promise<Response> => fetch(new URL(path, environment.baseUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-artifact-test-control": environment.controlToken,
  },
  body,
  signal: AbortSignal.timeout(LOCAL_CONTROL_REQUEST_TIMEOUT_MS),
});

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
  readonly mimeType: string;
}> => {
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  let resultSha256: string | undefined;
  let resultMimeType: string | undefined;
  for (let index = 0; index < 100; index += 1) {
    const result = await host.callTool("read_artifact", {
      share_url: shareUrl,
      max_bytes: 32,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.isError) throw new Error("ArtifactPass read_artifact returned an error");
    const value = asRecord(result.value);
    const manifest = asRecord(value.manifest);
    if (
      typeof value.data !== "string" ||
      typeof value.sha256 !== "string" ||
      value.content_trust !== "untrusted" ||
      typeof value.safety_boundary !== "string" ||
      typeof manifest.mime_type !== "string"
    ) {
      throw new Error("ArtifactPass read result omitted source evidence");
    }
    chunks.push(Buffer.from(value.data, "base64"));
    resultSha256 = value.sha256;
    resultMimeType = manifest.mime_type;
    if (value.next_cursor === null) {
      return { bytes: Buffer.concat(chunks), sha256: resultSha256, mimeType: resultMimeType };
    }
    if (typeof value.next_cursor !== "string") throw new Error("ArtifactPass returned an invalid cursor");
    cursor = value.next_cursor;
  }
  throw new Error("ArtifactPass cursor traversal exceeded its deterministic bound");
};

const armLocalFault = async (
  environment: LocalEvalEnvironment,
  shareUrl: string,
  mode: "corrupt-source" | "delete-source" | "redirect-manifest" | "malformed-manifest",
): Promise<void> => {
  const response = await requestLocalControl(
    environment,
    "/__local-test/fault",
    JSON.stringify({ share_url: shareUrl, mode }),
  );
  if (!response.ok) throw new Error(`Could not arm deterministic local fault ${mode}`);
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
  const publishedUrls: string[] = [];
  for (const fixture of scenario.fixtures) {
    const sourcePath = join(repositoryRoot, fixture.path);
    const targetPath = join(environment.workspaces.agentA, "fixtures", fixture.id, fixture.path.split("/").at(-1)!);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, targetPath);
    const expected = await readFile(sourcePath);
    if (expected.byteLength > scenario.budgets.max_artifact_bytes) {
      throw new Error(`Fixture ${fixture.id} exceeds its declared artifact budget`);
    }
    const shareUrl = await publish(host, targetPath);
    publishedUrls.push(shareUrl);
    const reconstructed = await reconstruct(host, shareUrl);
    failures.push(...verifyExactBytes({
      expected,
      actual: reconstructed.bytes,
      expectedSha256: sha256(expected),
      actualSha256: reconstructed.sha256,
    }));
    if (reconstructed.mimeType !== fixture.mime_type) {
      failures.push({
        code: "media_type_mismatch",
        message: `Fixture ${fixture.id} returned a different media type`,
        safety: false,
      });
    }
  }
  const faultSource = join(repositoryRoot, scenario.fixtures[0]!.path);
  const faultBytes = await readFile(faultSource);
  const publishFaultFixture = async (name: string): Promise<string> => {
    const path = join(environment.workspaces.agentA, "fixtures", "faults", `${name}.md`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await copyFile(faultSource, path);
    const shareUrl = await publish(host, path);
    publishedUrls.push(shareUrl);
    return shareUrl;
  };
  const corruptedUrl = await publishFaultFixture("corrupted-source");
  await armLocalFault(environment, corruptedUrl, "corrupt-source");
  try {
    const corrupted = await reconstruct(host, corruptedUrl);
    if (verifyExactBytes({
      expected: faultBytes,
      actual: corrupted.bytes,
      expectedSha256: sha256(faultBytes),
      actualSha256: corrupted.sha256,
    }).length === 0) {
      failures.push({
        code: "corrupted_content_undetected",
        message: "Corrupted ArtifactPass source passed exact-byte verification",
        safety: true,
      });
    }
  } catch {
    // A fail-closed read is also a valid corruption response.
  }
  for (const [name, mode, code] of [
    ["incomplete-source", "delete-source", "incomplete_content_accepted"],
    ["redirect-manifest", "redirect-manifest", "redirect_accepted"],
    ["malformed-manifest", "malformed-manifest", "malformed_manifest_accepted"],
  ] as const) {
    const shareUrl = await publishFaultFixture(name);
    await armLocalFault(environment, shareUrl, mode);
    await expectRefusal(host, shareUrl, failures, code);
  }
  await expectRefusal(host, "not-a-url", failures, "malformed_link_accepted");
  await expectRefusal(
    host,
    `https://foreign.invalid/a/${"f".repeat(43)}`,
    failures,
    "foreign_origin_accepted",
  );
  const futureNow = Date.now() + 901_000;
  const timeResponse = await requestLocalControl(
    environment,
    "/__local-test/time",
    JSON.stringify({ now_ms: futureNow }),
  );
  if (!timeResponse.ok) throw new Error("Could not advance deterministic local service time");
  for (const shareUrl of publishedUrls) {
    await expectRefusal(host, shareUrl, failures, "expired_link_accepted");
  }
  const revocationSourcePath = join(environment.workspaces.agentA, "fixtures", "revocation.md");
  await mkdir(dirname(revocationSourcePath), { recursive: true, mode: 0o700 });
  await copyFile(join(repositoryRoot, scenario.fixtures[0]!.path), revocationSourcePath);
  const revokedShareUrl = await publish(host, revocationSourcePath);
  const revokeResponse = await requestLocalControl(
    environment,
    "/__local-test/revoke",
    JSON.stringify({ share_url: revokedShareUrl }),
  );
  if (!revokeResponse.ok) throw new Error("Could not revoke deterministic local share");
  await expectRefusal(host, revokedShareUrl, failures, "revoked_link_accepted");
  const cleanupResponse = await requestLocalControl(environment, "/__local-test/cleanup", "{}");
  const cleanup = await cleanupResponse.json().catch(() => null) as {
    readonly failed?: unknown;
    readonly rows?: unknown;
    readonly objects?: unknown;
  } | null;
  if (!cleanupResponse.ok || cleanup?.failed !== 0 || cleanup.rows !== 0 || cleanup.objects !== 0) {
    failures.push({ code: "physical_cleanup", message: "Expired artifact cleanup left local state", safety: true });
  }
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
  let agentBHost: GenericMcpHost | undefined;
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
    const agentBInstall = await installCandidateIntoLocalEval({
      environment,
      repositoryRoot: options.repositoryRoot,
      agent: "agent-b",
    });
    const agentBMcpConfigPath = agentBInstall.receipt.portable_bundle.mcp_config;
    if (agentBMcpConfigPath === undefined) throw new Error("Handoff eval requires Agent B portable MCP registration");
    agentBHost = await connectGenericMcpHost({
      mcpConfigPath: agentBMcpConfigPath,
      cwd: environment.workspaces.agentB,
      environment: {
        ...createLocalEvalProcessEnvironment(environment.homes.agentB),
        ARTIFACTPASS_CONFIG_PATH: join(environment.homes.agentB, ".artifactpass", "config.json"),
      },
    });
    failures = [
      ...trial.failures,
      ...await runGenericTransportGates({
        repositoryRoot: options.repositoryRoot,
        environment,
        agentA: host,
        agentB: agentBHost,
      }),
    ];
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
    await agentBHost?.close().catch(() => { teardownFailed = true; });
    await host?.close().catch(() => { teardownFailed = true; });
    await environment?.stop().catch(() => { teardownFailed = true; });
  }
  const combined = outcomeWithTeardown(trialOutcome, teardownFailed);
  const candidateSha256 = await candidateDigest(options.repositoryRoot);
  const completedAt = Date.now();
  const report = {
    version: 1 as const,
    run_id: runId,
    candidate: { sha256: candidateSha256 },
    receipt_version: receiptVersion,
    scenario: { id: scenario.id, version: scenario.version },
    scorer_version: scenario.scorer_version,
    host: { agent_a: "generic" as const, agent_b: "generic" as const, runtime: `node-${process.version}` },
    cohort: { profile: "deterministic" as const, trial_index: 1, trial_count: 1 },
    result: {
      version: 1 as const,
      run_id: runId,
      scenario_id: scenario.id,
      candidate_sha256: candidateSha256,
      started_at: startedAtIso,
      completed_at: new Date(completedAt).toISOString(),
      trial_outcome: combined.trialOutcome,
      outcome: combined.outcome,
      gate_class: scenario.gate_class,
      host_pair: { agent_a: "generic" as const, agent_b: "generic" as const },
      ...(trialOutcome === "infrastructure_failure"
        ? { infrastructure_code: "deterministic_runner" }
        : {}),
      teardown: teardownFailed ? "failed" as const : "passed" as const,
      observed_actions: [...(host?.events ?? []), ...(agentBHost?.events ?? [])]
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
