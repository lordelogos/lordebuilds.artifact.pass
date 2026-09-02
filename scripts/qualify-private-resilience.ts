import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { runDeployCommand } from "../packages/setup-cli/src/commands/deploy";
import { CloudflareClient } from "../packages/setup-cli/src/cloudflare/client";
import { DeploymentMutationError } from "../packages/setup-cli/src/cloudflare/deployment";
import { runProcess, type ProcessRunner } from "../packages/setup-cli/src/process";
import { privateDeploymentAccessTokenForInspection } from "../packages/setup-cli/src/private-deployment/deployment-authorization";
import {
  compilePrivateDeploymentSpecification,
  deploymentInputFromPrivateSpecification,
} from "../packages/setup-cli/src/private-deployment/deployment-specification";
import {
  createPrivateDeploymentState,
  privateDeploymentStateRoot,
  resolvePrivateDeploymentState,
  writePrivateDeploymentState,
  type PrivateDeploymentStage,
  type PrivateDeploymentState,
} from "../packages/setup-cli/src/private-deployment/deployment-state";
import { capturePublicResourceMutableEvidence } from "./inspect-public-resource-inventory";

const valueAfter = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined) throw new Error(`Missing ${name}`);
  return value;
};

const checkpointOrder = [
  ["started", "started"],
  ["setup-introduction-accepted", "started"],
  ["registrar-authority-confirmed", "started"],
  ["sign-in-mode-selected", "authorization-required"],
  ["cloudflare-authorized", "cloudflare-authorized"],
  ["account-selected", "account-selected"],
  ["zone-active", "zone-active"],
  ["prerequisites-ready", "prerequisites-ready"],
  ["identity-ready", "identity-ready"],
  ["retention-ready", "retention-ready"],
  ["specification-ready", "specification-ready"],
  ["approval-ready", "approval-ready"],
  ["deployment-started", "deploying"],
  ["hosted-verification", "complete"],
] as const satisfies readonly (readonly [string, PrivateDeploymentStage])[];

const qualificationHostname = "private-qualification-staging.artifactpass.com";

const digest = (value: unknown): string => createHash("sha256")
  .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest("hex");

const execFileAsync = promisify(execFile);

export const inspectPersistedCheckpoint = async (
  root: string,
  selector: string,
  checkpoint: string,
  stage: PrivateDeploymentStage,
  next?: string,
): Promise<{ readonly checkpoint: string; readonly stage: PrivateDeploymentStage }> => {
  const resumed = await resolvePrivateDeploymentState(root, selector);
  if (resumed.checkpoints[checkpoint] === undefined || resumed.stage !== stage) {
    throw new Error(`Checkpoint ${checkpoint} did not survive process-independent reload`);
  }
  if (next !== undefined && resumed.checkpoints[next] !== undefined) {
    throw new Error(`Checkpoint ${checkpoint} incorrectly persisted later progress`);
  }
  return { checkpoint, stage };
};

const healthEvidence = async (state: PrivateDeploymentState): Promise<{ readonly deploymentIdMatches: boolean }> => {
  if (state.hostname === undefined) throw new Error("Private deployment hostname is missing");
  const response = await fetch(`https://${state.hostname}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as { readonly status?: unknown; readonly deployment_id?: unknown };
  if (!response.ok || body.status !== "ok" || body.deployment_id !== state.deployment_id) {
    throw new Error("The existing private Worker is not healthy");
  }
  return { deploymentIdMatches: true };
};

const workerDigest = async (
  client: CloudflareClient,
  accountId: string,
  serviceName: string,
): Promise<string> => {
  const scripts = await client.request<readonly Record<string, unknown>[]>(
    `/accounts/${accountId}/workers/scripts?per_page=1000`,
  );
  const worker = scripts.find((candidate) => candidate.id === serviceName);
  if (worker === undefined) throw new Error("The private Worker service is missing");
  return digest(worker);
};

const proveCheckpointReload = async (
  state: PrivateDeploymentState,
  remoteDigest: string,
): Promise<Record<string, unknown>> => {
  const root = await mkdtemp(resolve(tmpdir(), "artifactpass-checkpoint-resume-"));
  try {
    const separateWorkingDirectory = resolve(root, "unrelated-working-directory");
    await mkdir(separateWorkingDirectory);
    let persisted = await createPrivateDeploymentState({
      root,
      cliVersion: state.last_written_by_cli_version,
      createId: () => state.deployment_id,
    });
    for (let index = 0; index < checkpointOrder.length; index += 1) {
      const [checkpoint, stage] = checkpointOrder[index] as (typeof checkpointOrder)[number];
      const checkpointNames = new Set(checkpointOrder.slice(0, index + 1).map(([name]) => name));
      const checkpoints = Object.fromEntries(Object.entries(state.checkpoints)
        .filter(([name]) => checkpointNames.has(name as (typeof checkpointOrder)[number][0])));
      const finalCheckpoint = checkpoint === "hosted-verification";
      persisted = await writePrivateDeploymentState(root, {
        ...state,
        updated_at: persisted.updated_at,
        status: finalCheckpoint ? "complete" : "incomplete",
        stage,
        checkpoints,
        ...(checkpointNames.has("approval-ready") ? {} : { approval: undefined }),
      }, state.last_written_by_cli_version);
      const next = checkpointOrder[index + 1]?.[0];
      const moduleUrl = new URL(import.meta.url);
      moduleUrl.search = "";
      const source = [
        "const loaded = await import(process.env.ARTIFACTPASS_QUALIFICATION_MODULE);",
        "const result = await loaded.inspectPersistedCheckpoint(",
        "process.env.ARTIFACTPASS_QUALIFICATION_ROOT,",
        "process.env.ARTIFACTPASS_QUALIFICATION_SELECTOR,",
        "process.env.ARTIFACTPASS_QUALIFICATION_CHECKPOINT,",
        "process.env.ARTIFACTPASS_QUALIFICATION_STAGE,",
        "process.env.ARTIFACTPASS_QUALIFICATION_NEXT || undefined);",
        "process.stdout.write(JSON.stringify(result));",
      ].join("\n");
      const child = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: separateWorkingDirectory,
        env: {
          ...process.env,
          ARTIFACTPASS_QUALIFICATION_MODULE: moduleUrl.href,
          ARTIFACTPASS_QUALIFICATION_ROOT: root,
          ARTIFACTPASS_QUALIFICATION_SELECTOR: state.hostname ?? state.deployment_id,
          ARTIFACTPASS_QUALIFICATION_CHECKPOINT: checkpoint,
          ARTIFACTPASS_QUALIFICATION_STAGE: stage,
          ARTIFACTPASS_QUALIFICATION_NEXT: next ?? "",
        },
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      });
      const reloaded = JSON.parse(child.stdout) as { readonly checkpoint?: unknown; readonly stage?: unknown };
      if (reloaded.checkpoint !== checkpoint || reloaded.stage !== stage) {
        throw new Error(`Checkpoint ${checkpoint} child-process evidence is invalid`);
      }
    }
    return {
      event: "private-checkpoint-reload-passed",
      checkpoints_reloaded: checkpointOrder.length,
      separate_process_per_checkpoint: true,
      unrelated_working_directory: true,
      resolved_from_hostname: state.hostname !== undefined,
      remote_snapshot_digest: remoteDigest,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const runPrivateResilienceQualification = async (): Promise<void> => {
  const selector = valueAfter("--resume");
  const evidencePathIndex = process.argv.indexOf("--evidence-path");
  const evidencePath = evidencePathIndex === -1 ? undefined : process.argv[evidencePathIndex + 1];
  if (evidencePathIndex !== -1 && evidencePath === undefined) throw new Error("Missing --evidence-path");
  const state = await resolvePrivateDeploymentState(privateDeploymentStateRoot(), selector);
  const accountId = state.cloudflare?.account_id;
  const serviceName = state.service_name;
  if (accountId === undefined || serviceName === undefined || state.hostname === undefined) {
    throw new Error("The private deployment state is incomplete");
  }
  if (state.hostname !== qualificationHostname) {
    throw new Error(`Live resilience qualification is restricted to ${qualificationHostname}`);
  }
  const resolveToken = async (): Promise<string> => {
    const token = await privateDeploymentAccessTokenForInspection(state);
    if (token === null) throw new Error("An active private deployment authorization is required");
    return token;
  };
  const client = new CloudflareClient({ resolveToken });
  await client.verifyToken();
  const specification = compilePrivateDeploymentSpecification(state);
  const sourceDeploymentRoot = resolve("packages/setup-cli/dist/deployment");
  const root = await mkdtemp(resolve(tmpdir(), "artifactpass-private-resilience-"));
  try {
    const deploymentRoot = resolve(root, "deployment");
    await cp(sourceDeploymentRoot, deploymentRoot, { recursive: true });
    const approvalPath = resolve(root, "approval.json");
    await runDeployCommand(deploymentInputFromPrivateSpecification(specification, {
      dryRun: false,
      writeApprovalManifest: approvalPath,
    }), { deploymentRoot, resolveToken });
    const approval = JSON.parse(await readFile(approvalPath, "utf8")) as {
      readonly binding?: { readonly bundleSha256?: unknown; readonly remote?: unknown };
    };
    if (typeof approval.binding?.bundleSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(approval.binding.bundleSha256)) {
      throw new Error("The qualification approval manifest lacks a valid deployment bundle digest");
    }
    const remoteDigest = digest(approval.binding?.remote ?? null);
    const checkpointEvidence = await proveCheckpointReload(state, remoteDigest);

    const changedBundle = resolve(root, "changed-deployment");
    await cp(deploymentRoot, changedBundle, { recursive: true });
    const changedWorker = resolve(changedBundle, "index.js");
    await writeFile(changedWorker, `${await readFile(changedWorker, "utf8")}\n// qualification drift\n`, { mode: 0o600 });
    let driftRefused = false;
    await runDeployCommand(deploymentInputFromPrivateSpecification(specification, {
      dryRun: false,
      approveManifest: approvalPath,
    }), {
      deploymentRoot: changedBundle,
      resolveToken,
      runner: async (command, args, options) => {
        if (args[0] !== "r2" || args[1] !== "object" || args[2] !== "get") {
          throw new Error("A deployment mutation was attempted before drift refusal");
        }
        return runProcess(command, args, options);
      },
    }).catch((error: unknown) => {
      driftRefused = error instanceof Error && error.message.includes("approval manifest no longer matches");
      if (!driftRefused) throw error;
    });
    if (!driftRefused) throw new Error("Approved deployment drift was not refused");
    const driftEvidence = {
      event: "private-manifest-drift-refused",
      mutation_started: false,
      approved_remote_digest: remoteDigest,
    } as const;

    const publicBefore = await capturePublicResourceMutableEvidence(state, client);
    const workerBefore = await workerDigest(client, accountId, serviceName);
    await healthEvidence(state);
    const mutationCommands: string[] = [];
    const injectedRunner: ProcessRunner = async (command, args, options) => {
      if (args[0] === "deploy") throw new Error("qualification failure before Worker replacement");
      const result = await runProcess(command, args, options);
      if (args[0] === "d1" || (args[0] === "r2" && args[1] === "bucket" && args[2] === "lifecycle")) {
        mutationCommands.push(args.slice(0, 3).join(" "));
      }
      return result;
    };
    let containedFailure: DeploymentMutationError | undefined;
    await runDeployCommand(deploymentInputFromPrivateSpecification(specification, {
      dryRun: false,
      approveManifest: approvalPath,
    }), {
      deploymentRoot,
      resolveToken,
      runner: injectedRunner,
    }).catch((error: unknown) => {
      if (!(error instanceof DeploymentMutationError)) throw error;
      containedFailure = error;
    });
    if (containedFailure === undefined) throw new Error("The pre-Worker failure was not injected");
    if (containedFailure.changed.length !== 0) {
      throw new Error("Idempotent storage preparation was incorrectly reported as a resource change");
    }
    if (JSON.stringify(mutationCommands) !== JSON.stringify(["d1 migrations apply", "r2 bucket lifecycle"])) {
      throw new Error("Pre-Worker containment did not execute the expected storage preparation operations");
    }
    const workerAfter = await workerDigest(client, accountId, serviceName);
    const health = await healthEvidence(state);
    if (workerBefore !== workerAfter) throw new Error("The previous Worker changed during pre-Worker containment");
    const containmentEvidence = {
      event: "private-pre-worker-failure-containment-passed",
      completed_operations: mutationCommands,
      changed_resources: containedFailure.changed,
      worker_replacement_started: false,
      worker_unchanged: true,
      worker_healthy: health.deploymentIdMatches,
      rollback_required: false,
      containment: "idempotent storage preparation completed; Worker replacement did not start",
    } as const;
    const publicAfter = await capturePublicResourceMutableEvidence(state, client);
    if (
      publicBefore.identity_digest !== publicAfter.identity_digest ||
      publicBefore.mutable_state_digest !== publicAfter.mutable_state_digest ||
      JSON.stringify(publicBefore.resource_counts) !== JSON.stringify(publicAfter.resource_counts)
    ) {
      throw new Error("The public ArtifactPass deployment changed during private resilience qualification");
    }
    const evidence = {
      version: 1,
      recorded_at: new Date().toISOString(),
      environment: "isolated-private-staging",
      deployment_reference: state.deployment_id.slice(0, 8),
      command: `ARTIFACTPASS_CLOUDFLARE_OAUTH_ENVIRONMENT=staging pnpm test:private-resilience:live -- --resume ${selector}`,
      deployment_bundle_sha256: approval.binding.bundleSha256,
      checkpoint_reload: { status: "passed", ...checkpointEvidence },
      manifest_drift: { status: "passed", ...driftEvidence },
      pre_worker_failure_containment: { status: "passed", ...containmentEvidence },
      public_resource_isolation: {
        status: "passed",
        before: {
          identity_digest: publicBefore.identity_digest,
          mutable_state_digest: publicBefore.mutable_state_digest,
        },
        after: {
          identity_digest: publicAfter.identity_digest,
          mutable_state_digest: publicAfter.mutable_state_digest,
        },
        resource_counts: publicAfter.resource_counts,
        oauth_client_mutation_scope_present: publicAfter.oauth_client_mutation_scope_present,
      },
      secrets_or_live_capabilities_recorded: false,
    } as const;
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    if (evidencePath !== undefined) await writeFile(resolve(evidencePath), serializedEvidence, { mode: 0o600 });
    process.stdout.write(serializedEvidence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrivateResilienceQualification();
}
