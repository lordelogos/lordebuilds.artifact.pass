import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import {
  ARTIFACTPASS_MCP_TOOL_NAMES,
  defaultLocalConfigPath,
  readLocalBridgeSettings,
  redactSensitiveText,
  selectLocalBridgeProfile,
  writeLocalBridgeSettings,
  type LocalBridgeSettings,
} from "agent-bridge";

import packageMetadata from "../package.json" with { type: "json" };
import { connectHost, type ConnectDependencies } from "./commands/connect";
import { detectHosts, installPluginForHosts, type HostInstallation } from "./hosts";
import { smokeArtifactpassMcp, type McpSmokeResult } from "./mcp-smoke";
import {
  defaultPortableIntegrationDirectory,
  installPortableIntegration,
  portableIntegrationWasCreated,
  type PortableIntegration,
} from "./portable-integration";
import { runProcess, type ProcessRunner } from "./process";
import { applyWorkspaceConfiguration } from "./workspace-configuration";

export const installReceiptVersion = 3 as const;

type InstallStage = "preflight" | "bundle" | "connection" | "verified" | "receipt" | "committed";

interface InstallJournal {
  readonly version: 1;
  readonly operation_id: string;
  readonly status: "in-progress" | "committed" | "rolled-back";
  readonly stage: InstallStage;
  readonly started_at: number;
  readonly resumed_from?: string;
}

export interface ArtifactpassInstallReceipt {
  readonly receipt_version: typeof installReceiptVersion;
  readonly product: "ArtifactPass";
  readonly product_version: string;
  readonly operation_id: string;
  readonly status: "success" | "failed";
  readonly profile: string;
  readonly origin: string;
  readonly workspace_roots: readonly string[];
  readonly adapters: readonly ("codex" | "claude")[];
  readonly portable_bundle: {
    readonly sha256: string;
    readonly host_registration: "installed" | "manual-required" | "not-reached";
    readonly mcp_config?: string;
    readonly skills_directory?: string;
  };
  readonly mcp: {
    readonly negotiated: boolean;
    readonly tools: readonly string[];
    readonly representative_invocation: boolean;
  };
  readonly skills: {
    readonly verified: boolean;
    readonly names: readonly string[];
  };
  readonly credential: "reused" | "created" | "rotated" | "none" | "not-reached";
  readonly migration: {
    readonly actions: readonly string[];
    readonly legacy_preserved: boolean;
  };
  readonly outcomes: readonly string[];
  readonly restart_required: boolean;
  readonly rollback: "not-required" | "complete" | "incomplete";
  readonly rollback_failures?: readonly string[];
  readonly failed_stage?: InstallStage;
  readonly resumed_from?: string;
  readonly receipt_path: string;
}

const receiptRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const receiptStringArray = (value: unknown, allowed?: ReadonlySet<string>): value is string[] =>
  Array.isArray(value) && value.every((item) =>
    typeof item === "string" && item.length > 0 && (allowed === undefined || allowed.has(item)));

const receiptEnum = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && allowed.includes(value as T);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

export const parseArtifactpassInstallReceipt = (value: unknown): ArtifactpassInstallReceipt => {
  const receipt = receiptRecord(value);
  const portable = receiptRecord(receipt?.portable_bundle);
  const mcp = receiptRecord(receipt?.mcp);
  const skills = receiptRecord(receipt?.skills);
  const migration = receiptRecord(receipt?.migration);
  const adapters = new Set(["codex", "claude"]);
  const tools = new Set<string>(ARTIFACTPASS_MCP_TOOL_NAMES);
  const skillNames = new Set(["read-shared-artifact", "share-artifact"]);
  const valid = receipt !== undefined &&
    hasOnlyKeys(receipt, [
      "receipt_version", "product", "product_version", "operation_id", "status", "profile", "origin",
      "workspace_roots", "adapters", "portable_bundle", "mcp", "skills", "credential", "migration",
      "outcomes", "restart_required", "rollback", "rollback_failures", "failed_stage", "resumed_from",
      "receipt_path",
    ]) &&
    receipt.receipt_version === installReceiptVersion &&
    receipt.product === "ArtifactPass" &&
    typeof receipt.product_version === "string" && receipt.product_version.length > 0 &&
    typeof receipt.operation_id === "string" && receipt.operation_id.length > 0 &&
    receiptEnum(receipt.status, ["success", "failed"]) &&
    typeof receipt.profile === "string" && receipt.profile.length > 0 &&
    typeof receipt.origin === "string" && receipt.origin.length > 0 &&
    receiptStringArray(receipt.workspace_roots) && receipt.workspace_roots.length > 0 &&
    receiptStringArray(receipt.adapters, adapters) &&
    portable !== undefined && hasOnlyKeys(portable, [
      "sha256", "host_registration", "mcp_config", "skills_directory",
    ]) &&
    typeof portable.sha256 === "string" &&
    receiptEnum(portable.host_registration, ["installed", "manual-required", "not-reached"]) &&
    (portable.mcp_config === undefined || typeof portable.mcp_config === "string") &&
    (portable.skills_directory === undefined || typeof portable.skills_directory === "string") &&
    mcp !== undefined && hasOnlyKeys(mcp, ["negotiated", "tools", "representative_invocation"]) &&
    typeof mcp.negotiated === "boolean" && receiptStringArray(mcp.tools, tools) &&
    typeof mcp.representative_invocation === "boolean" &&
    skills !== undefined && hasOnlyKeys(skills, ["verified", "names"]) &&
    typeof skills.verified === "boolean" && receiptStringArray(skills.names, skillNames) &&
    receiptEnum(receipt.credential, ["reused", "created", "rotated", "none", "not-reached"]) &&
    migration !== undefined && hasOnlyKeys(migration, ["actions", "legacy_preserved"]) &&
    receiptStringArray(migration.actions) && typeof migration.legacy_preserved === "boolean" &&
    receiptStringArray(receipt.outcomes) && typeof receipt.restart_required === "boolean" &&
    receiptEnum(receipt.rollback, ["not-required", "complete", "incomplete"]) &&
    (receipt.rollback_failures === undefined ||
      (receiptStringArray(receipt.rollback_failures) && receipt.rollback_failures.length > 0)) &&
    (receipt.failed_stage === undefined || receiptEnum(receipt.failed_stage, [
      "preflight", "bundle", "connection", "verified", "receipt", "committed",
    ])) &&
    (receipt.resumed_from === undefined ||
      (typeof receipt.resumed_from === "string" && receipt.resumed_from.length > 0)) &&
    typeof receipt.receipt_path === "string" && receipt.receipt_path.length > 0;
  if (!valid) throw new Error(`ArtifactPass install receipt v${installReceiptVersion} is invalid`);
  return receipt as unknown as ArtifactpassInstallReceipt;
};

export class ArtifactpassInstallError extends Error {
  public constructor(
    message: string,
    public readonly receipt: ArtifactpassInstallReceipt,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactpassInstallError";
  }
}

export interface ArtifactpassInstallInput {
  readonly baseUrl?: string;
  readonly profileName?: string;
  readonly workspaceRoot?: string;
  readonly marketplaceSource: string;
  readonly configPath?: string;
  readonly receiptDirectory?: string;
  readonly openDevelopment?: boolean;
  readonly installKnownHostAdapters?: boolean;
  readonly connectAfterInstall?: boolean;
}

export interface ArtifactpassInstallDependencies {
  readonly connect?: typeof connectHost;
  readonly connectDependencies: ConnectDependencies;
  readonly installPortable?: typeof installPortableIntegration;
  readonly portableWasCreated?: typeof portableIntegrationWasCreated;
  readonly smoke?: typeof smokeArtifactpassMcp;
  readonly runner?: ProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly now?: () => number;
  readonly operationId?: () => string;
  readonly staleLockMilliseconds?: number;
  readonly skipCredentialStorePreflight?: boolean;
  readonly afterStage?: (stage: InstallStage) => Promise<void> | void;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const readJournal = async (path: string): Promise<InstallJournal | null> =>
  readFile(path, "utf8").then((contents) => JSON.parse(contents) as InstallJournal)
    .catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });

const acquireLock = async (
  path: string,
  now: () => number,
  staleLockMilliseconds: number,
): Promise<() => Promise<void>> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: now() }));
      await handle.close();
      return async () => rm(path, { force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const metadata = await stat(path);
      if (now() - metadata.mtimeMs <= staleLockMilliseconds) {
        throw new Error("Another ArtifactPass installation is already running");
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire the ArtifactPass installation lock");
};

const verifyWorkspace = async (workspaceRoot: string, homeDirectory: string): Promise<void> => {
  const metadata = await stat(workspaceRoot);
  if (!metadata.isDirectory()) throw new Error("ArtifactPass workspace root must be a directory");
  if (workspaceRoot === parse(workspaceRoot).root) {
    throw new Error("ArtifactPass refuses to authorize a filesystem root");
  }
  if (workspaceRoot === resolve(homeDirectory)) {
    throw new Error("ArtifactPass refuses to authorize an entire home directory implicitly");
  }
};

const verifyCredentialStore = async (
  platform: NodeJS.Platform,
  runner: ProcessRunner,
): Promise<void> => {
  if (platform === "darwin") {
    await access("/usr/bin/security", constants.X_OK);
    return;
  }
  if (platform === "linux") {
    await runner("secret-tool", ["--version"], { timeoutMilliseconds: 5_000 });
    return;
  }
  throw new Error(`ArtifactPass one-command installation does not support ${platform}`);
};

const verifySkills = async (portable: PortableIntegration): Promise<readonly string[]> => {
  const names = (await readdir(portable.skillsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(["read-shared-artifact", "share-artifact"])) {
    throw new Error("ArtifactPass portable skills verification failed");
  }
  await Promise.all(names.map((name) => stat(join(portable.skillsDirectory, name, "SKILL.md"))));
  return names;
};

export const renderInstallReceipt = (receipt: ArtifactpassInstallReceipt): string => {
  if (receipt.status === "failed") {
    if (receipt.rollback === "incomplete") {
      return `ArtifactPass installation failed during ${receipt.failed_stage ?? "setup"}. Rollback is incomplete: ${(receipt.rollback_failures ?? ["unknown state"]).join(", ")}.`;
    }
    return `ArtifactPass installation failed during ${receipt.failed_stage ?? "setup"}.`;
  }
  const registration = receipt.portable_bundle.host_registration === "manual-required"
    ? `Manual host registration required. MCP: ${receipt.portable_bundle.mcp_config ?? "unavailable"}; skills: ${receipt.portable_bundle.skills_directory ?? "unavailable"}.`
    : `Installed for ${receipt.adapters.join(" and ")}.`;
  const connection = receipt.credential === "none"
    ? `ArtifactPass is installed for ${receipt.profile} and is not connected. Open it in your agent and choose Connect ArtifactPass when you want to publish.`
    : `ArtifactPass is connected to ${receipt.origin} for ${receipt.profile}.`;
  return `${connection} ${registration} Start a new agent session before using it.`;
};

const leafErrorMessages = (error: unknown, seen = new Set<unknown>()): readonly string[] => {
  if (error === undefined || error === null || seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    const nested = error.errors.flatMap((candidate) => leafErrorMessages(candidate, seen));
    return nested.length > 0 ? nested : [error.message];
  }
  if (error instanceof Error) {
    const nested = leafErrorMessages(error.cause, seen);
    return nested.length > 0 ? nested : [error.message];
  }
  return [];
};

export const renderInstallFailure = (error: ArtifactpassInstallError): string => {
  const details = [...new Set(leafErrorMessages(error.cause)
    .map((message) => redactSensitiveText(message).replace(/\s+/gu, " ").trim())
    .filter((message) => message.length > 0))]
    .slice(0, 3)
    .join(" | ");
  return details.length > 0
    ? `${renderInstallReceipt(error.receipt)}\nCause: ${details}`
    : renderInstallReceipt(error.receipt);
};

export const runArtifactpassInstall = async (
  input: ArtifactpassInstallInput,
  dependencies: ArtifactpassInstallDependencies,
): Promise<ArtifactpassInstallReceipt> => {
  const connectAfterInstall = input.connectAfterInstall === true;
  const now = dependencies.now ?? Date.now;
  const operationId = (dependencies.operationId ?? randomUUID)();
  let origin = new URL(input.baseUrl ?? "https://artifactpass.com").origin;
  let profileName = input.profileName ?? (input.openDevelopment === true ? "local" : "production");
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const configPath = input.configPath ?? defaultLocalConfigPath();
  const receiptDirectory = resolve(input.receiptDirectory ?? join(dirname(configPath), "receipts"));
  const receiptPath = join(receiptDirectory, `${operationId}.json`);
  const journalPath = `${configPath}.install.json`;
  const releaseLock = await acquireLock(
    `${configPath}.install.lock`,
    now,
    dependencies.staleLockMilliseconds ?? 5 * 60_000,
  );
  let stage: InstallStage = "preflight";
  let journal: InstallJournal | undefined;
  let portable: PortableIntegration | undefined;
  let smoke: McpSmokeResult | undefined;
  let skills: readonly string[] = [];
  let connectResult: Awaited<ReturnType<typeof connectHost>> | undefined;
  let hostInstallation: HostInstallation | undefined;
  let hostRegistrationAttempted = false;
  let configSnapshot: { readonly existed: boolean; readonly bytes?: Buffer } | undefined;
  let previousSettings: LocalBridgeSettings | null = null;
  const outcomes: string[] = [];
  try {
    const previousJournal = await readJournal(journalPath);
    const resumedFrom = previousJournal?.status === "in-progress"
      ? previousJournal.operation_id
      : undefined;
    journal = {
      version: 1,
      operation_id: operationId,
      status: "in-progress",
      stage,
      started_at: now(),
      ...(resumedFrom === undefined ? {} : { resumed_from: resumedFrom }),
    };
    await writeJson(journalPath, journal);
    await verifyWorkspace(workspaceRoot, dependencies.homeDirectory ?? homedir());
    configSnapshot = await readFile(configPath)
      .then((bytes) => ({ existed: true as const, bytes }))
      .catch((error: unknown) => {
        if (isMissing(error)) return { existed: false as const };
        throw error;
      });
    previousSettings = configSnapshot.existed && configSnapshot.bytes !== undefined
      ? await readLocalBridgeSettings(configPath)
      : null;
    if (input.baseUrl === undefined && input.profileName === undefined && previousSettings !== null) {
      const selected = selectLocalBridgeProfile(previousSettings, undefined, workspaceRoot);
      origin = new URL(selected.settings.base_url).origin;
      profileName = selected.name;
    }
    if (
      connectAfterInstall &&
      dependencies.skipCredentialStorePreflight !== true &&
      input.openDevelopment !== true
    ) {
      await verifyCredentialStore(
        dependencies.platform ?? process.platform,
        dependencies.runner ?? runProcess,
      );
    }
    outcomes.push("preflight:passed");
    await dependencies.afterStage?.("preflight");

    stage = "bundle";
    journal = { ...journal, stage };
    await writeJson(journalPath, journal);
    const installedPortable = await (dependencies.installPortable ?? installPortableIntegration)({
      marketplaceSource: input.marketplaceSource,
      destinationDirectory: defaultPortableIntegrationDirectory(configPath),
    });
    portable = installedPortable;
    outcomes.push("portable-bundle:verified");
    await dependencies.afterStage?.("bundle");

    stage = "connection";
    journal = { ...journal, stage };
    await writeJson(journalPath, journal);
    if (connectAfterInstall) {
      hostRegistrationAttempted = input.installKnownHostAdapters !== false;
      connectResult = await (dependencies.connect ?? connectHost)({
        baseUrl: origin,
        profileName,
        workspaceRoots: [workspaceRoot],
        marketplaceSource: installedPortable.marketplaceDirectory,
        openDevelopment: input.openDevelopment === true,
        installKnownHostAdapters: input.installKnownHostAdapters !== false,
        ...(input.configPath === undefined ? {} : { configPath }),
      }, {
        ...dependencies.connectDependencies,
        installPortable: async () => installedPortable,
        captureHostInstallation: (installation) => {
          hostInstallation = installation;
        },
        verifyConnection: async (context) => {
          [smoke, skills] = await Promise.all([
            (dependencies.smoke ?? smokeArtifactpassMcp)({
              mcpConfigPath: installedPortable.mcpConfig,
              localConfigPath: context.configPath,
            }),
            verifySkills(installedPortable),
          ]);
        },
      });
    } else {
      await writeLocalBridgeSettings(configPath, applyWorkspaceConfiguration(previousSettings, {
        baseUrl: origin,
        profileName,
        workspaceRoot,
      }, input.openDevelopment === true));
      const runner = dependencies.runner ?? runProcess;
      const hosts = input.installKnownHostAdapters === false ? [] : await detectHosts(runner);
      hostRegistrationAttempted = hosts.length > 0;
      hostInstallation = hosts.length === 0
        ? undefined
        : await installPluginForHosts(hosts, installedPortable.marketplaceDirectory, runner);
      [smoke, skills] = await Promise.all([
        (dependencies.smoke ?? smokeArtifactpassMcp)({
          mcpConfigPath: installedPortable.mcpConfig,
          localConfigPath: configPath,
        }),
        verifySkills(installedPortable),
      ]);
      connectResult = {
        hosts,
        profileName,
        configPath,
      };
    }
    outcomes.push(`credential:${connectResult.credentialAction ?? "none"}`);
    outcomes.push("host-registration:installed-or-reported");
    await dependencies.afterStage?.("connection");

    stage = "verified";
    journal = { ...journal, stage };
    await writeJson(journalPath, journal);
    if (smoke === undefined || skills.length !== 2) {
      throw new Error("ArtifactPass installation verification did not complete");
    }
    outcomes.push("mcp:negotiated");
    outcomes.push("skills:verified");
    await dependencies.afterStage?.("verified");

    stage = "receipt";
    journal = { ...journal, stage };
    await writeJson(journalPath, journal);
    const manualRegistration = connectResult.hosts.length === 0;
    const receipt: ArtifactpassInstallReceipt = {
      receipt_version: installReceiptVersion,
      product: "ArtifactPass",
      product_version: packageMetadata.version,
      operation_id: operationId,
      status: "success",
      profile: connectResult.profileName,
      origin,
      workspace_roots: [workspaceRoot],
      adapters: connectResult.hosts,
      portable_bundle: {
        sha256: portable.digest,
        host_registration: manualRegistration ? "manual-required" : "installed",
        ...(manualRegistration
          ? { mcp_config: portable.mcpConfig, skills_directory: portable.skillsDirectory }
          : {}),
      },
      mcp: {
        negotiated: smoke.negotiated,
        tools: smoke.tools,
        representative_invocation: smoke.representativeInvocation,
      },
      skills: { verified: true, names: skills },
      credential: connectResult.credentialAction ?? "none",
      migration: {
        actions: connectResult.migration?.actions ?? [],
        legacy_preserved: connectResult.migration?.legacyPreserved ?? false,
      },
      outcomes,
      restart_required: true,
      rollback: "not-required",
      ...(journal.resumed_from === undefined ? {} : { resumed_from: journal.resumed_from }),
      receipt_path: receiptPath,
    };
    await writeJson(receiptPath, receipt);
    await dependencies.afterStage?.("receipt");

    stage = "committed";
    journal = { ...journal, status: "committed", stage };
    await writeJson(journalPath, journal);
    await dependencies.afterStage?.("committed");
    return receipt;
  } catch (error) {
    const rollbackFailures: string[] = [];
    let hostRollbackComplete = !hostRegistrationAttempted;
    if (hostInstallation !== undefined) {
      await hostInstallation.rollback()
        .then(() => {
          hostRollbackComplete = true;
        })
        .catch(() => rollbackFailures.push("host-registration"));
    } else if ((connectResult?.hosts.length ?? 0) > 0) {
      rollbackFailures.push("host-registration-unverified");
    }
    if (
      portable !== undefined &&
      hostRollbackComplete &&
      !hostRegistrationAttempted &&
      (dependencies.portableWasCreated ?? portableIntegrationWasCreated)(portable)
    ) {
      await rm(portable.rootDirectory, { recursive: true, force: true })
        .catch(() => rollbackFailures.push("portable-bundle"));
    }
    if (configSnapshot !== undefined) {
      const restore = configSnapshot.existed && configSnapshot.bytes !== undefined
        ? writeFile(configPath, configSnapshot.bytes, { mode: 0o600 })
        : rm(configPath, { force: true });
      await restore.catch(() => rollbackFailures.push("configuration"));
    }
    if (connectResult?.credentialAction === "created" || connectResult?.credentialAction === "rotated") {
      rollbackFailures.push("credential-unverified");
    }
    if (journal !== undefined) {
      await writeJson(journalPath, { ...journal, status: "rolled-back" }).catch(() => undefined);
    }
    const failureReceipt: ArtifactpassInstallReceipt = {
      receipt_version: installReceiptVersion,
      product: "ArtifactPass",
      product_version: packageMetadata.version,
      operation_id: operationId,
      status: "failed",
      profile: profileName,
      origin,
      workspace_roots: [workspaceRoot],
      adapters: connectResult?.hosts ?? [],
      portable_bundle: {
        sha256: portable?.digest ?? "",
        host_registration: "not-reached",
      },
      mcp: {
        negotiated: smoke?.negotiated ?? false,
        tools: smoke?.tools ?? [],
        representative_invocation: smoke?.representativeInvocation ?? false,
      },
      skills: { verified: skills.length === 2, names: skills },
      credential: connectResult?.credentialAction ?? "not-reached",
      migration: {
        actions: connectResult?.migration?.actions ?? [],
        legacy_preserved: connectResult?.migration?.legacyPreserved ?? false,
      },
      outcomes: [
        ...outcomes,
        rollbackFailures.length === 0 ? "rollback:complete" : "rollback:incomplete",
      ],
      restart_required: false,
      rollback: rollbackFailures.length === 0 ? "complete" : "incomplete",
      ...(rollbackFailures.length === 0 ? {} : { rollback_failures: rollbackFailures }),
      failed_stage: stage,
      ...(journal?.resumed_from === undefined ? {} : { resumed_from: journal.resumed_from }),
      receipt_path: receiptPath,
    };
    await writeJson(receiptPath, failureReceipt).catch(() => undefined);
    throw new ArtifactpassInstallError(
      `ArtifactPass installation failed during ${stage}`,
      failureReceipt,
      { cause: error },
    );
  } finally {
    await releaseLock();
  }
};
