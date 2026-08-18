import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { defaultLocalConfigPath } from "agent-bridge";

import packageMetadata from "../package.json" with { type: "json" };
import { connectHost, type ConnectDependencies } from "./commands/connect";
import { smokeArtifactpassMcp, type McpSmokeResult } from "./mcp-smoke";
import {
  defaultPortableIntegrationDirectory,
  installPortableIntegration,
  type PortableIntegration,
} from "./portable-integration";
import { runProcess, type ProcessRunner } from "./process";

export const installReceiptVersion = 1 as const;

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
  readonly rollback: "not-required" | "complete";
  readonly failed_stage?: InstallStage;
  readonly resumed_from?: string;
  readonly receipt_path: string;
}

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
}

export interface ArtifactpassInstallDependencies {
  readonly connect?: typeof connectHost;
  readonly connectDependencies: ConnectDependencies;
  readonly installPortable?: typeof installPortableIntegration;
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
    return `ArtifactPass installation failed during ${receipt.failed_stage ?? "setup"}. Previous working state was restored.`;
  }
  const registration = receipt.portable_bundle.host_registration === "manual-required"
    ? `Manual host registration required. MCP: ${receipt.portable_bundle.mcp_config ?? "unavailable"}; skills: ${receipt.portable_bundle.skills_directory ?? "unavailable"}.`
    : `Installed for ${receipt.adapters.join(" and ")}.`;
  return `ArtifactPass is connected to ${receipt.origin} for ${receipt.profile}. ${registration} Start a new agent session before using it.`;
};

export const runArtifactpassInstall = async (
  input: ArtifactpassInstallInput,
  dependencies: ArtifactpassInstallDependencies,
): Promise<ArtifactpassInstallReceipt> => {
  const now = dependencies.now ?? Date.now;
  const operationId = (dependencies.operationId ?? randomUUID)();
  const origin = new URL(input.baseUrl ?? "https://artifactpass.com").origin;
  const profileName = input.profileName ?? (input.openDevelopment === true ? "local" : "production");
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
    if (dependencies.skipCredentialStorePreflight !== true && input.openDevelopment !== true) {
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
    portable = await (dependencies.installPortable ?? installPortableIntegration)({
      sourceRoot: resolve(input.marketplaceSource, "plugins/artifactpass"),
      destinationDirectory: defaultPortableIntegrationDirectory(configPath),
    });
    outcomes.push("portable-bundle:verified");
    await dependencies.afterStage?.("bundle");

    stage = "connection";
    journal = { ...journal, stage };
    await writeJson(journalPath, journal);
    connectResult = await (dependencies.connect ?? connectHost)({
      baseUrl: origin,
      profileName,
      workspaceRoots: [workspaceRoot],
      marketplaceSource: input.marketplaceSource,
      openDevelopment: input.openDevelopment === true,
      installKnownHostAdapters: input.installKnownHostAdapters !== false,
      ...(input.configPath === undefined ? {} : { configPath }),
    }, {
      ...dependencies.connectDependencies,
      verifyConnection: async (context) => {
        smoke = await (dependencies.smoke ?? smokeArtifactpassMcp)({
          mcpConfigPath: portable?.mcpConfig ?? "",
          localConfigPath: context.configPath,
        });
        skills = await verifySkills(portable as PortableIntegration);
      },
    });
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
      outcomes,
      restart_required: false,
      rollback: "complete",
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
