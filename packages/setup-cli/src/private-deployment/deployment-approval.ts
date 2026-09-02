import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runDeployCommand, type DeployCommandDependencies } from "../commands/deploy";
import type { DeploymentResult } from "../cloudflare/deployment";
import { DeploymentMutationError } from "../cloudflare/deployment";
import type { BrowserHandoffPrompt } from "./browser-handoff";
import type { PrivateDeploymentAuthorizationSession } from "./deployment-authorization";
import {
  compilePrivateDeploymentSpecification,
  deploymentInputFromPrivateSpecification,
  privateDeploymentSpecificationDigest,
  type PrivateDeploymentSpecification,
} from "./deployment-specification";
import {
  createPrivateDeploymentReceipt,
  writePrivateDeploymentReceipt,
  type PrivateDeploymentReceipt,
} from "./deployment-receipt";
import {
  invalidatePrivateDeploymentCheckpoints,
  provePrivateDeploymentCheckpoint,
  writePrivateDeploymentState,
  type PrivateDeploymentState,
} from "./deployment-state";

export interface PrivateDeploymentApprovalDependencies {
  readonly root: string;
  readonly cliVersion: string;
  readonly deploymentRoot: string;
  readonly prompt: BrowserHandoffPrompt;
  readonly authorization: PrivateDeploymentAuthorizationSession;
  readonly now?: () => Date;
  readonly runDeploy?: (
    input: Parameters<typeof runDeployCommand>[0],
    dependencies: DeployCommandDependencies,
  ) => Promise<DeploymentResult>;
}

export interface PrivateDeploymentApprovalResult {
  readonly action: "saved" | "approval-invalidated" | "repair-required" | "complete";
  readonly state: PrivateDeploymentState;
  readonly message: string;
  readonly result?: DeploymentResult;
  readonly receipt?: PrivateDeploymentReceipt;
  readonly receiptPath?: string;
}

const askChoice = async (
  prompt: BrowserHandoffPrompt,
  question: string,
  options: readonly string[],
): Promise<number> => {
  for (;;) {
    const answer = await prompt.question(`${question}\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n> `);
    const choice = Number.parseInt(answer.trim(), 10) - 1;
    if (Number.isInteger(choice) && options[choice] !== undefined) return choice;
    prompt.write(`Choose a number from 1 to ${options.length}.\n`);
  }
};

const chooseHostname = async (state: PrivateDeploymentState, prompt: BrowserHandoffPrompt): Promise<string> => {
  if (state.hostname !== undefined) return state.hostname;
  const zone = state.cloudflare?.zone_name;
  if (zone === undefined) throw new Error("Choose a Cloudflare domain before the deployment hostname");
  const choice = await askChoice(prompt, "Where should this private ArtifactPass deployment live?", [
    `artifacts.${zone}`,
    zone,
    "Another hostname on this domain",
  ]);
  if (choice === 0) return `artifacts.${zone}`;
  if (choice === 1) return zone;
  return (await prompt.question("Deployment hostname:\n> ")).trim().toLowerCase();
};

const safeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Cloudflare deployment failed";
  return message
    .replace(/https:\/\/[^\s]+\/a\/[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{40,}/gu, "[REDACTED]")
    .slice(0, 1_000);
};

const persist = async (
  state: PrivateDeploymentState,
  dependencies: PrivateDeploymentApprovalDependencies,
): Promise<PrivateDeploymentState> => writePrivateDeploymentState(
  dependencies.root,
  state,
  dependencies.cliVersion,
  dependencies.now,
);

const renderReview = (specification: PrivateDeploymentSpecification): string => [
  "Review this private ArtifactPass deployment",
  `Hostname: ${specification.hostname}`,
  `Cloudflare account: ${specification.account_id}`,
  `Cloudflare domain: ${specification.zone_name}`,
  `Login: ${specification.identity.mode === "email-code" ? "Email verification code" : "Company login"}`,
  `Publisher rules: ${specification.identity.rules.map((rule) => rule.kind === "authenticated" ? "selected providers" : rule.value).join(", ")}`,
  `Link lifetimes: ${specification.retention.allowed_expiry_seconds.map((seconds) => seconds < 3600 ? `${seconds / 60} min` : seconds < 86_400 ? `${seconds / 3600} hr` : `${seconds / 86_400} day`).join(", ")}`,
  "Storage: R2 in this Cloudflare account",
  "Metadata: D1 in this Cloudflare account",
  "Placement: Cloudflare Automatic",
  "",
].join("\n");

export const runPrivateDeploymentApproval = async (
  initialState: PrivateDeploymentState,
  dependencies: PrivateDeploymentApprovalDependencies,
): Promise<PrivateDeploymentApprovalResult> => {
  const now = dependencies.now ?? (() => new Date());
  const runDeploy = dependencies.runDeploy ?? runDeployCommand;
  let authorizedState = initialState;
  if (authorizedState.checkpoints["cloudflare-authorized"] === undefined) {
    authorizedState = provePrivateDeploymentCheckpoint(authorizedState, "cloudflare-authorized", {
      source: dependencies.authorization.source,
      client_environment: dependencies.authorization.client?.environment ?? "api-token",
      profile: dependencies.authorization.profile,
      granted_scopes: dependencies.authorization.grantedScopes,
      persisted: dependencies.authorization.persisted,
    }, "cloudflare-authorized", now());
    authorizedState = await persist(authorizedState, dependencies);
  }
  const hostname = await chooseHostname(authorizedState, dependencies.prompt);
  const specification = compilePrivateDeploymentSpecification(authorizedState, { hostname });
  const specificationDigest = privateDeploymentSpecificationDigest(specification);
  let state = provePrivateDeploymentCheckpoint({
    ...authorizedState,
    hostname: specification.hostname,
    service_name: specification.service_name,
  }, "specification-ready", {
    specification_version: specification.version,
    specification_digest: specificationDigest,
    hostname: specification.hostname,
    service_name: specification.service_name,
  }, "specification-ready", now());
  state = await persist(state, dependencies);

  const approvalDirectory = resolve(dependencies.root, "approvals");
  await mkdir(approvalDirectory, { recursive: true, mode: 0o700 });
  const approvalPath = resolve(approvalDirectory, `${state.deployment_id}.json`);
  const input = deploymentInputFromPrivateSpecification(specification, {
    dryRun: false,
    writeApprovalManifest: approvalPath,
  });
  await runDeploy(input, {
    deploymentRoot: dependencies.deploymentRoot,
    resolveToken: dependencies.authorization.resolveAccessToken,
  });
  const manifestDigest = createHash("sha256").update(await readFile(approvalPath)).digest("hex");
  state = provePrivateDeploymentCheckpoint({
    ...state,
    approval: { manifest_path: approvalPath, manifest_digest: manifestDigest },
  }, "approval-ready", {
    specification_digest: specificationDigest,
    manifest_digest: manifestDigest,
  }, "approval-ready", now());
  state = await persist(state, dependencies);

  dependencies.prompt.write(renderReview(specification));
  const decision = await askChoice(dependencies.prompt, "What should ArtifactPass do?", [
    "Approve and deploy",
    "Save and exit",
    "Back",
  ]);
  if (decision === 1) {
    return {
      action: "saved",
      state,
      message: "Deployment approval is ready and no Cloudflare resources were changed.",
    };
  }
  if (decision === 2) {
    state = await persist(invalidatePrivateDeploymentCheckpoints(
      state,
      ["specification-ready", "approval-ready"],
      "retention-ready",
    ), dependencies);
    return {
      action: "saved",
      state,
      message: "Deployment approval was discarded. Earlier setup choices are still saved.",
    };
  }

  state = provePrivateDeploymentCheckpoint({
    ...state,
    approval: { ...state.approval, approved_at: now().toISOString() },
  }, "deployment-started", {
    specification_digest: specificationDigest,
    manifest_digest: manifestDigest,
  }, "deploying", now());
  state = await persist(state, dependencies);
  try {
    const result = await runDeploy(deploymentInputFromPrivateSpecification(specification, {
      dryRun: false,
      approveManifest: approvalPath,
    }), {
      deploymentRoot: dependencies.deploymentRoot,
      resolveToken: dependencies.authorization.resolveAccessToken,
    });
    const receipt = createPrivateDeploymentReceipt(specification, result, now());
    const receiptPath = await writePrivateDeploymentReceipt(dependencies.root, receipt);
    state = provePrivateDeploymentCheckpoint({
      ...state,
      status: "complete",
      resources: {
        ...state.resources,
        ...result.resources,
        deployment_receipt_path: receiptPath,
      },
    }, "hosted-verification", {
      health: "passed",
      protected_upload: "passed",
      verified_at: result.verification?.verifiedAt,
    }, "complete", now());
    state = await persist(state, dependencies);
    return {
      action: "complete",
      state,
      result,
      receipt,
      receiptPath,
      message: `Private ArtifactPass is ready at ${result.baseUrl}.`,
    };
  } catch (error) {
    const reason = safeFailure(error);
    if (reason.includes("approval manifest no longer matches")) {
      state = invalidatePrivateDeploymentCheckpoints(
        state,
        ["approval-ready", "deployment-started"],
        "specification-ready",
      );
      state = provePrivateDeploymentCheckpoint(state, "approval-invalidated", {
        reason,
        mutation_started: false,
      }, "specification-ready", now());
      state = await persist(state, dependencies);
      return {
        action: "approval-invalidated",
        state,
        message: "Cloudflare changed after review. No deployment mutation started. Review a fresh approval.",
      };
    }
    state = provePrivateDeploymentCheckpoint(state, "deployment-failure", {
      reason,
      changed: error instanceof DeploymentMutationError ? error.changed : [],
      rolled_back: error instanceof DeploymentMutationError ? error.rolledBack : [],
      rollback_failures: error instanceof DeploymentMutationError ? error.rollbackFailures : [],
      resources: error instanceof DeploymentMutationError ? error.resources : {},
      recovery: ["retry-safely", "run-doctor", "save-and-exit", "view-repair-instructions"],
    }, "repair-required", now());
    state = await persist(state, dependencies);
    return {
      action: "repair-required",
      state,
      message: `Deployment stopped safely: ${reason}`,
    };
  }
};
