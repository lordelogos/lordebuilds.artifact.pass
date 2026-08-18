import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ARTIFACTPASS_CREDENTIAL_SERVICE,
  LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
  OsCredentialStore,
  agentCredentialAccountForProfile,
  defaultLocalConfigPath,
  legacyLocalConfigPath,
  readLocalBridgeSettings,
  writeLocalBridgeSettings,
  type CredentialStore,
  type LocalBridgeSettings,
} from "agent-bridge";

const journalVersion = 1 as const;

type MigrationStage =
  | "started"
  | "credentials-staged"
  | "config-staged"
  | "verified"
  | "committed"
  | "rolled-back";

interface MigrationJournal {
  readonly version: typeof journalVersion;
  readonly operation_id: string;
  readonly status: "in-progress" | "committed" | "rolled-back";
  readonly stage: MigrationStage;
  readonly started_at: number;
  readonly legacy_config_path: string;
  readonly artifactpass_config_path: string;
  readonly legacy_config_digest?: string;
  readonly artifactpass_config_digest?: string;
  readonly created_credential_accounts: readonly string[];
  readonly created_config: boolean;
  readonly previous_config?: LocalBridgeSettings;
}

export interface LocalStateMigrationOptions {
  readonly artifactpassConfigPath: string;
  readonly legacyConfigPath: string;
  readonly artifactpassCredentialStore: (account: string) => CredentialStore;
  readonly legacyCredentialStore: (account: string) => CredentialStore;
  readonly now?: () => number;
  readonly staleLockMilliseconds?: number;
  readonly afterStage?: (stage: MigrationStage) => Promise<void> | void;
}

export interface LocalStateMigrationResult {
  readonly operationId: string;
  readonly status: "committed";
  readonly actions: readonly string[];
  readonly configPath: string;
  readonly legacyPreserved: boolean;
}

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const readOptionalSettings = async (path: string): Promise<LocalBridgeSettings | null> =>
  readLocalBridgeSettings(path).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");

const writeJournal = async (path: string, journal: MigrationJournal): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const readJournal = async (path: string): Promise<MigrationJournal | null> =>
  readFile(path, "utf8").then((contents) => JSON.parse(contents) as MigrationJournal).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
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
        throw new Error("Another ArtifactPass migration is already running");
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire the ArtifactPass migration lock");
};

const migrationAccounts = (settings: LocalBridgeSettings): readonly string[] => {
  const accounts = new Set<string>();
  for (const [profileName, profile] of Object.entries(settings.profiles)) {
    if (profile.open_development !== true) {
      accounts.add(agentCredentialAccountForProfile(profileName));
    }
    if (profile.pdf_key_id !== undefined) {
      accounts.add(`pdf-signing-key:${profile.pdf_key_id}`);
    }
  }
  return [...accounts].sort();
};

const migratedSettings = (
  settings: LocalBridgeSettings,
  legacyConfigPath: string,
): LocalBridgeSettings => ({
  ...settings,
  profiles: Object.fromEntries(Object.entries(settings.profiles).map(([name, profile]) => [
    name,
    {
      ...profile,
      credential_namespace: "artifactpass" as const,
      ...(profile.publication_state === "legacy" && profile.publication_state_path === undefined
        ? { publication_state_path: `${legacyConfigPath}.publication-state` }
        : {}),
    },
  ])),
});

export const migrateLegacyLocalState = async (
  options: LocalStateMigrationOptions,
): Promise<LocalStateMigrationResult> => {
  const now = options.now ?? Date.now;
  const journalPath = `${options.artifactpassConfigPath}.migration.json`;
  const lockPath = `${options.artifactpassConfigPath}.migration.lock`;
  const releaseLock = await acquireLock(
    lockPath,
    now,
    options.staleLockMilliseconds ?? 5 * 60_000,
  );
  try {
    const previousJournal = await readJournal(journalPath);
    if (previousJournal?.status === "committed") {
      if (previousJournal.artifactpass_config_digest !== undefined) {
        await readLocalBridgeSettings(options.artifactpassConfigPath);
      }
      return {
        operationId: previousJournal.operation_id,
        status: "committed",
        actions: [],
        configPath: options.artifactpassConfigPath,
        legacyPreserved: true,
      };
    }
    if (previousJournal?.status === "in-progress") {
      for (const account of [...previousJournal.created_credential_accounts].reverse()) {
        await options.artifactpassCredentialStore(account).delete();
      }
      if (previousJournal.created_config) {
        await rm(options.artifactpassConfigPath, { force: true });
      } else if (previousJournal.previous_config !== undefined) {
        await writeLocalBridgeSettings(options.artifactpassConfigPath, previousJournal.previous_config);
      }
      await writeJournal(journalPath, {
        ...previousJournal,
        status: "rolled-back",
        stage: "rolled-back",
      });
    }

    const artifactpassSettings = await readOptionalSettings(options.artifactpassConfigPath);
    const legacySettings = options.legacyConfigPath === options.artifactpassConfigPath
      ? null
      : await readOptionalSettings(options.legacyConfigPath);
    if (artifactpassSettings === null && legacySettings === null) {
      const operationId = randomUUID();
      const journal: MigrationJournal = {
        version: journalVersion,
        operation_id: operationId,
        status: "committed",
        stage: "committed",
        started_at: now(),
        legacy_config_path: options.legacyConfigPath,
        artifactpass_config_path: options.artifactpassConfigPath,
        created_credential_accounts: [],
        created_config: false,
      };
      await writeJournal(journalPath, journal);
      return {
        operationId,
        status: "committed",
        actions: [],
        configPath: options.artifactpassConfigPath,
        legacyPreserved: false,
      };
    }
    if (
      artifactpassSettings !== null && legacySettings !== null &&
      digest(artifactpassSettings) !== digest(legacySettings)
    ) {
      throw new Error("ArtifactPass and legacy Artifact Share configs conflict; no state was changed");
    }
    const sourceSettings = artifactpassSettings ?? legacySettings;
    if (sourceSettings === null) throw new Error("ArtifactPass migration source disappeared");
    const operationId = randomUUID();
    let journal: MigrationJournal = {
      version: journalVersion,
      operation_id: operationId,
      status: "in-progress",
      stage: "started",
      started_at: now(),
      legacy_config_path: options.legacyConfigPath,
      artifactpass_config_path: options.artifactpassConfigPath,
      ...(legacySettings === null ? {} : { legacy_config_digest: digest(legacySettings) }),
      created_credential_accounts: [],
      created_config: false,
      ...(artifactpassSettings === null ? {} : { previous_config: artifactpassSettings }),
    };
    const actions: string[] = [];
    await writeJournal(journalPath, journal);
    try {
      await options.afterStage?.("started");
      for (const account of migrationAccounts(sourceSettings)) {
        const artifactpassStore = options.artifactpassCredentialStore(account);
        const legacyStore = options.legacyCredentialStore(account);
        const artifactpassValue = await artifactpassStore.get();
        const legacyValue = await legacyStore.get();
        if (
          artifactpassValue !== null && legacyValue !== null &&
          artifactpassValue !== legacyValue
        ) {
          throw new Error(`ArtifactPass and legacy Artifact Share credentials conflict for ${account}`);
        }
        if (artifactpassValue === null && legacyValue !== null) {
          journal = {
            ...journal,
            created_credential_accounts: [...journal.created_credential_accounts, account],
          };
          await writeJournal(journalPath, journal);
          await artifactpassStore.set(legacyValue);
          if (await artifactpassStore.get() !== legacyValue) {
            throw new Error(`ArtifactPass credential verification failed for ${account}`);
          }
          actions.push(`credential:${account}`);
        }
      }
      journal = { ...journal, stage: "credentials-staged" };
      await writeJournal(journalPath, journal);
      await options.afterStage?.("credentials-staged");

      const nextSettings = migratedSettings(sourceSettings, options.legacyConfigPath);
      journal = {
        ...journal,
        created_config: artifactpassSettings === null,
        artifactpass_config_digest: digest(nextSettings),
      };
      await writeJournal(journalPath, journal);
      await writeLocalBridgeSettings(options.artifactpassConfigPath, nextSettings);
      journal = { ...journal, stage: "config-staged" };
      await writeJournal(journalPath, journal);
      actions.push("config");
      await options.afterStage?.("config-staged");

      const verified = await readLocalBridgeSettings(options.artifactpassConfigPath);
      if (digest(verified) !== digest(nextSettings)) {
        throw new Error("ArtifactPass config verification failed");
      }
      for (const account of journal.created_credential_accounts) {
        if (await options.artifactpassCredentialStore(account).get() === null) {
          throw new Error(`ArtifactPass credential verification failed for ${account}`);
        }
      }
      journal = { ...journal, stage: "verified" };
      await writeJournal(journalPath, journal);
      await options.afterStage?.("verified");

      journal = { ...journal, status: "committed", stage: "committed" };
      await writeJournal(journalPath, journal);
      await options.afterStage?.("committed");
      return {
        operationId,
        status: "committed",
        actions,
        configPath: options.artifactpassConfigPath,
        legacyPreserved: legacySettings !== null,
      };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const account of [...journal.created_credential_accounts].reverse()) {
        await options.artifactpassCredentialStore(account).delete().catch((rollbackError: unknown) => {
          rollbackErrors.push(rollbackError);
        });
      }
      if (journal.created_config) {
        await rm(options.artifactpassConfigPath, { force: true }).catch((rollbackError: unknown) => {
          rollbackErrors.push(rollbackError);
        });
      } else if (journal.previous_config !== undefined) {
        await writeLocalBridgeSettings(options.artifactpassConfigPath, journal.previous_config)
          .catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
      }
      await writeJournal(journalPath, {
        ...journal,
        status: "rolled-back",
        stage: "rolled-back",
      }).catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "ArtifactPass migration failed and rollback was incomplete");
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
};

export const migrateDefaultLocalState = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LocalStateMigrationResult> => migrateLegacyLocalState({
  artifactpassConfigPath: defaultLocalConfigPath(environment),
  legacyConfigPath: legacyLocalConfigPath(environment),
  artifactpassCredentialStore: (account) => new OsCredentialStore({
    service: ARTIFACTPASS_CREDENTIAL_SERVICE,
    account,
  }),
  legacyCredentialStore: (account) => new OsCredentialStore({
    service: LEGACY_ARTIFACT_SHARE_CREDENTIAL_SERVICE,
    account,
  }),
});
