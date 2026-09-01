import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { defaultLocalConfigPath } from "agent-bridge";

export const privateDeploymentSchemaVersion = 1 as const;
export const maximumDeploymentStateBytes = 256 * 1024;

export type PrivateDeploymentStage =
  | "started"
  | "authorization-required"
  | "cloudflare-authorized"
  | "account-selected"
  | "zone-active"
  | "prerequisites-ready"
  | "identity-ready"
  | "specification-ready"
  | "approval-ready"
  | "deploying"
  | "repair-required"
  | "deployed"
  | "verified"
  | "complete";

export type PrivateDeploymentStatus = "incomplete" | "complete" | "abandoned";
export type PrivateSignInMode = "email-code" | "company-login";

export interface PrivateDeploymentCheckpoint {
  readonly proven_at: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface PrivateDeploymentState {
  readonly schema_version: typeof privateDeploymentSchemaVersion;
  readonly deployment_id: string;
  readonly created_by_cli_version: string;
  readonly last_written_by_cli_version: string;
  readonly status: PrivateDeploymentStatus;
  readonly stage: PrivateDeploymentStage;
  readonly created_at: string;
  readonly updated_at: string;
  readonly hostname?: string;
  readonly service_name?: string;
  readonly registrar_authority_confirmed?: boolean;
  readonly sign_in_mode?: PrivateSignInMode;
  readonly cloudflare?: {
    readonly account_id?: string;
    readonly account_name?: string;
    readonly zone_id?: string;
    readonly zone_name?: string;
  };
  readonly resources?: Readonly<Record<string, string>>;
  readonly retention_seconds?: readonly number[];
  readonly pending_handoff?: {
    readonly kind: "cloudflare-authorization" | "domain" | "r2" | "zero-trust" | "identity-provider";
    readonly readiness: string;
    readonly last_checked_at?: string;
    readonly last_evidence?: Readonly<Record<string, unknown>>;
  };
  readonly approval?: {
    readonly manifest_path?: string;
    readonly manifest_digest?: string;
    readonly approved_at?: string;
  };
  readonly checkpoints: Readonly<Record<string, PrivateDeploymentCheckpoint>>;
}

interface HostnameIndex {
  readonly schema_version: 1;
  readonly hostname: string;
  readonly deployment_id: string;
  readonly updated_at: string;
}

export interface DeploymentStateStoreOptions {
  readonly root?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly cliVersion: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly staleLockMilliseconds?: number;
}

const deploymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const cliVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const forbiddenStateKey = /(?:^|_)(?:access|refresh|api|agent)?_?(?:token|secret|private_key|authorization_code|code_verifier|artifact_bytes|share_url)(?:$|_)/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const canonicalHostname = (value: string): string => {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!hostnamePattern.test(hostname)) throw new Error("Choose a valid lowercase hostname");
  return hostname;
};

const assertNoSecrets = (value: unknown, path = "deployment"): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenStateKey.test(key)) {
      throw new Error(`Deployment state cannot store secret-bearing field ${path}.${key}`);
    }
    assertNoSecrets(item, `${path}.${key}`);
  }
};

const requiredString = (value: unknown, field: string, maximum = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Deployment state requires ${field}`);
  }
  return value;
};

const optionalString = (value: unknown, field: string, maximum = 512): string | undefined =>
  value === undefined ? undefined : requiredString(value, field, maximum);

const isoDate = (value: unknown, field: string): string => {
  const result = requiredString(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || Number.isNaN(Date.parse(result))) {
    throw new Error(`Deployment state contains an invalid ${field}`);
  }
  return result;
};

const stages = new Set<PrivateDeploymentStage>([
  "started",
  "authorization-required",
  "cloudflare-authorized",
  "account-selected",
  "zone-active",
  "prerequisites-ready",
  "identity-ready",
  "specification-ready",
  "approval-ready",
  "deploying",
  "repair-required",
  "deployed",
  "verified",
  "complete",
]);

const statuses = new Set<PrivateDeploymentStatus>(["incomplete", "complete", "abandoned"]);
const signInModes = new Set<PrivateSignInMode>(["email-code", "company-login"]);
const handoffKinds = new Set([
  "cloudflare-authorization",
  "domain",
  "r2",
  "zero-trust",
  "identity-provider",
]);

const validateCheckpoint = (value: unknown, name: string): PrivateDeploymentCheckpoint => {
  if (!isRecord(value) || !isRecord(value.evidence)) {
    throw new Error(`Deployment checkpoint ${name} is invalid`);
  }
  return {
    proven_at: isoDate(value.proven_at, `checkpoint ${name} time`),
    evidence: value.evidence,
  };
};

export const validatePrivateDeploymentState = (
  value: unknown,
  currentCliVersion?: string,
): PrivateDeploymentState => {
  if (!isRecord(value)) throw new Error("Deployment state must contain a JSON object");
  if (value.schema_version !== privateDeploymentSchemaVersion) {
    const writer = typeof value.last_written_by_cli_version === "string"
      ? value.last_written_by_cli_version
      : typeof value.created_by_cli_version === "string"
        ? value.created_by_cli_version
        : "the CLI version that created it";
    const deploymentId = typeof value.deployment_id === "string" ? value.deployment_id : "<deployment-id>";
    throw new Error(
      `Deployment state schema ${String(value.schema_version)} is not supported by ArtifactPass ${currentCliVersion ?? "CLI"}. ` +
      `Resume it with \`pnpm dlx artifactpass@${writer} deploy --resume ${deploymentId}\``,
    );
  }
  assertNoSecrets(value);
  const deploymentId = requiredString(value.deployment_id, "deployment_id", 64);
  if (!deploymentIdPattern.test(deploymentId)) throw new Error("Deployment state contains an invalid deployment ID");
  const createdBy = requiredString(value.created_by_cli_version, "created_by_cli_version", 64);
  const lastWriter = requiredString(value.last_written_by_cli_version, "last_written_by_cli_version", 64);
  if (!cliVersionPattern.test(createdBy) || !cliVersionPattern.test(lastWriter)) {
    throw new Error("Deployment state contains an invalid CLI version");
  }
  if (!statuses.has(value.status as PrivateDeploymentStatus)) throw new Error("Deployment state has an invalid status");
  if (!stages.has(value.stage as PrivateDeploymentStage)) throw new Error("Deployment state has an invalid stage");
  if (!isRecord(value.checkpoints)) throw new Error("Deployment state requires checkpoints");
  const checkpoints = Object.fromEntries(Object.entries(value.checkpoints).map(([name, checkpoint]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) throw new Error("Deployment checkpoint names use kebab-case");
    return [name, validateCheckpoint(checkpoint, name)];
  }));
  const hostname = optionalString(value.hostname, "hostname", 253);
  if (hostname !== undefined && canonicalHostname(hostname) !== hostname) {
    throw new Error("Deployment state hostname must be normalized");
  }
  const signInMode = value.sign_in_mode as PrivateSignInMode | undefined;
  if (signInMode !== undefined && !signInModes.has(signInMode)) {
    throw new Error("Deployment state has an invalid sign-in mode");
  }
  const cloudflare = value.cloudflare;
  if (cloudflare !== undefined && !isRecord(cloudflare)) {
    throw new Error("Deployment state Cloudflare selection is invalid");
  }
  const resources = value.resources;
  if (
    resources !== undefined &&
    (!isRecord(resources) || !Object.values(resources).every((item) => typeof item === "string" && item.length > 0 && item.length <= 512))
  ) {
    throw new Error("Deployment state resources are invalid");
  }
  const retentionSeconds = value.retention_seconds;
  if (
    retentionSeconds !== undefined &&
    (!Array.isArray(retentionSeconds) || retentionSeconds.length === 0 ||
      !retentionSeconds.every((item) => Number.isInteger(item) && Number(item) > 0 && Number(item) <= 7 * 24 * 60 * 60))
  ) {
    throw new Error("Deployment state retention presets are invalid");
  }
  const pendingHandoff = value.pending_handoff;
  if (
    pendingHandoff !== undefined &&
    (!isRecord(pendingHandoff) || !handoffKinds.has(String(pendingHandoff.kind)) || typeof pendingHandoff.readiness !== "string")
  ) {
    throw new Error("Deployment state pending handoff is invalid");
  }
  const approval = value.approval;
  if (approval !== undefined && !isRecord(approval)) throw new Error("Deployment state approval is invalid");
  if (approval !== undefined && approval.manifest_digest !== undefined && !digestPattern.test(String(approval.manifest_digest))) {
    throw new Error("Deployment state approval digest is invalid");
  }
  return {
    schema_version: privateDeploymentSchemaVersion,
    deployment_id: deploymentId,
    created_by_cli_version: createdBy,
    last_written_by_cli_version: lastWriter,
    status: value.status as PrivateDeploymentStatus,
    stage: value.stage as PrivateDeploymentStage,
    created_at: isoDate(value.created_at, "created_at"),
    updated_at: isoDate(value.updated_at, "updated_at"),
    ...(hostname === undefined ? {} : { hostname }),
    ...(typeof value.service_name === "string" ? { service_name: value.service_name } : {}),
    ...(typeof value.registrar_authority_confirmed === "boolean"
      ? { registrar_authority_confirmed: value.registrar_authority_confirmed }
      : {}),
    ...(signInMode === undefined ? {} : { sign_in_mode: signInMode }),
    ...(cloudflare === undefined ? {} : {
      cloudflare: Object.fromEntries(Object.entries(cloudflare).map(([key, item]) => [
        key,
        requiredString(item, `cloudflare.${key}`),
      ])),
    }),
    ...(resources === undefined ? {} : { resources: resources as Record<string, string> }),
    ...(retentionSeconds === undefined ? {} : { retention_seconds: retentionSeconds as number[] }),
    ...(pendingHandoff === undefined ? {} : {
      pending_handoff: {
        kind: pendingHandoff.kind as PrivateDeploymentState["pending_handoff"] extends infer T
          ? T extends { kind: infer K } ? K : never
          : never,
        readiness: pendingHandoff.readiness as string,
        ...(typeof pendingHandoff.last_checked_at === "string"
          ? { last_checked_at: isoDate(pendingHandoff.last_checked_at, "handoff check time") }
          : {}),
        ...(isRecord(pendingHandoff.last_evidence) ? { last_evidence: pendingHandoff.last_evidence } : {}),
      },
    }),
    ...(approval === undefined ? {} : {
      approval: {
        ...(typeof approval.manifest_path === "string" ? { manifest_path: approval.manifest_path } : {}),
        ...(typeof approval.manifest_digest === "string" ? { manifest_digest: approval.manifest_digest } : {}),
        ...(typeof approval.approved_at === "string"
          ? { approved_at: isoDate(approval.approved_at, "approval time") }
          : {}),
      },
    }),
    checkpoints,
  };
};

export const privateDeploymentStateRoot = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string => resolve(dirname(defaultLocalConfigPath(environment, platform)), "deployments");

const statePath = (root: string, deploymentId: string): string =>
  resolve(root, "by-id", `${deploymentId}.json`);

const hostnameIndexPath = (root: string, hostname: string): string =>
  resolve(root, "by-hostname", `${canonicalHostname(hostname)}.json`);

const readBoundedJson = async (path: string): Promise<unknown> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Deployment state path must be a regular file");
  if (metadata.size > maximumDeploymentStateBytes) throw new Error("Deployment state file is too large");
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > maximumDeploymentStateBytes) throw new Error("Deployment state file is too large");
  return JSON.parse(contents) as unknown;
};

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
};

const createJsonFile = async (path: string, value: unknown): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const readHostnameIndex = async (root: string, hostname: string): Promise<HostnameIndex | null> =>
  readBoundedJson(hostnameIndexPath(root, hostname)).then((value) => {
    if (
      !isRecord(value) || value.schema_version !== 1 ||
      value.hostname !== canonicalHostname(hostname) ||
      typeof value.deployment_id !== "string" || !deploymentIdPattern.test(value.deployment_id)
    ) {
      throw new Error("ArtifactPass deployment hostname index is invalid");
    }
    return value as unknown as HostnameIndex;
  }).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });

export const readPrivateDeploymentState = async (
  root: string,
  deploymentId: string,
  currentCliVersion?: string,
): Promise<PrivateDeploymentState> => {
  if (!deploymentIdPattern.test(deploymentId)) throw new Error("Choose a valid deployment ID");
  return validatePrivateDeploymentState(await readBoundedJson(statePath(root, deploymentId)), currentCliVersion);
};

export const resolvePrivateDeploymentState = async (
  root: string,
  selector: string,
  currentCliVersion?: string,
): Promise<PrivateDeploymentState> => {
  if (deploymentIdPattern.test(selector)) return readPrivateDeploymentState(root, selector, currentCliVersion);
  const hostname = canonicalHostname(selector);
  const index = await readHostnameIndex(root, hostname);
  if (index === null) throw new Error(`No ArtifactPass deployment is recorded for ${hostname}`);
  return readPrivateDeploymentState(root, index.deployment_id, currentCliVersion);
};

export const listPrivateDeploymentStates = async (
  root: string,
  currentCliVersion?: string,
): Promise<readonly PrivateDeploymentState[]> => {
  const directory = resolve(root, "by-id");
  const entries = await readdir(directory).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const states = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readPrivateDeploymentState(root, entry.slice(0, -5), currentCliVersion)));
  return states.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || left.deployment_id.localeCompare(right.deployment_id));
};

export const createPrivateDeploymentState = async (
  options: DeploymentStateStoreOptions,
): Promise<PrivateDeploymentState> => {
  const root = options.root ?? privateDeploymentStateRoot(options.environment, options.platform);
  const deploymentId = (options.createId ?? randomUUID)();
  if (!deploymentIdPattern.test(deploymentId)) throw new Error("ArtifactPass generated an invalid deployment ID");
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const state = validatePrivateDeploymentState({
    schema_version: privateDeploymentSchemaVersion,
    deployment_id: deploymentId,
    created_by_cli_version: options.cliVersion,
    last_written_by_cli_version: options.cliVersion,
    status: "incomplete",
    stage: "started",
    created_at: timestamp,
    updated_at: timestamp,
    checkpoints: {
      started: { proven_at: timestamp, evidence: { state_initialized: true } },
    },
  }, options.cliVersion);
  await createJsonFile(statePath(root, deploymentId), state);
  return state;
};

export const writePrivateDeploymentState = async (
  root: string,
  stateValue: PrivateDeploymentState,
  cliVersion: string,
  now: () => Date = () => new Date(),
): Promise<PrivateDeploymentState> => {
  const previous = await readPrivateDeploymentState(root, stateValue.deployment_id, cliVersion);
  if (previous.updated_at !== stateValue.updated_at) {
    throw new Error("Deployment state changed in another process; reload it before saving");
  }
  const next = validatePrivateDeploymentState({
    ...stateValue,
    created_by_cli_version: previous.created_by_cli_version,
    last_written_by_cli_version: cliVersion,
    created_at: previous.created_at,
    updated_at: now().toISOString(),
  }, cliVersion);
  if (next.hostname !== undefined) {
    const existingIndex = await readHostnameIndex(root, next.hostname);
    if (existingIndex !== null && existingIndex.deployment_id !== next.deployment_id) {
      throw new Error(`${next.hostname} is already bound to another ArtifactPass deployment`);
    }
  }
  await atomicWriteJson(statePath(root, next.deployment_id), next);
  if (next.hostname !== undefined) {
    await atomicWriteJson(hostnameIndexPath(root, next.hostname), {
      schema_version: 1,
      hostname: next.hostname,
      deployment_id: next.deployment_id,
      updated_at: next.updated_at,
    } satisfies HostnameIndex);
  }
  if (previous.hostname !== undefined && previous.hostname !== next.hostname) {
    const previousIndex = await readHostnameIndex(root, previous.hostname);
    if (previousIndex?.deployment_id === next.deployment_id) {
      await rm(hostnameIndexPath(root, previous.hostname), { force: true });
    }
  }
  return next;
};

export const provePrivateDeploymentCheckpoint = (
  state: PrivateDeploymentState,
  name: string,
  evidence: Readonly<Record<string, unknown>>,
  stage: PrivateDeploymentStage,
  now: Date = new Date(),
): PrivateDeploymentState => validatePrivateDeploymentState({
  ...state,
  stage,
  checkpoints: {
    ...state.checkpoints,
    [name]: { proven_at: now.toISOString(), evidence },
  },
});

export const invalidatePrivateDeploymentCheckpoints = (
  state: PrivateDeploymentState,
  checkpointNames: readonly string[],
  stage: PrivateDeploymentStage,
): PrivateDeploymentState => {
  const checkpoints = { ...state.checkpoints };
  checkpointNames.forEach((name) => delete checkpoints[name]);
  return validatePrivateDeploymentState({
    ...state,
    status: "incomplete",
    stage,
    approval: undefined,
    checkpoints,
  });
};

export const withPrivateDeploymentLock = async <Result>(
  root: string,
  deploymentId: string,
  action: () => Promise<Result>,
  options: { readonly now?: () => number; readonly staleLockMilliseconds?: number } = {},
): Promise<Result> => {
  if (!deploymentIdPattern.test(deploymentId)) throw new Error("Choose a valid deployment ID");
  const now = options.now ?? Date.now;
  const staleLockMilliseconds = options.staleLockMilliseconds ?? 5 * 60_000;
  const path = resolve(root, "locks", `${deploymentId}.lock`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ deployment_id: deploymentId, pid: process.pid, created_at: now() }));
      await handle.sync();
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const metadata = await stat(path);
      if (now() - metadata.mtimeMs <= staleLockMilliseconds) {
        throw new Error(`ArtifactPass deployment ${deploymentId} is already open in another process`);
      }
      await rm(path, { force: true });
    }
  }
  if (!acquired) throw new Error("Could not acquire the ArtifactPass deployment lock");
  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
};
