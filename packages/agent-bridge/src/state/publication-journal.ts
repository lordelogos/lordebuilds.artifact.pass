import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PublicationAttempt {
  readonly publisherId: string;
  readonly attemptId: string;
  readonly shareToken: string;
}

export interface PublicationJournal {
  prepare(payloadCommitment: string, expiresAt: number): Promise<PublicationAttempt>;
  acknowledge(payloadCommitment: string, attemptId: string, expiresAt: number): Promise<void>;
}

interface JournalEntry {
  readonly attempt_id: string;
  readonly share_token: string;
  readonly updated_at: number;
  readonly expires_at: number;
}

interface JournalState {
  readonly version: 2;
  readonly publisher_id: string;
  readonly pending: Readonly<Record<string, JournalEntry>>;
  readonly acknowledged: Readonly<Record<string, JournalEntry>>;
}

export interface PublicationJournalOptions {
  readonly now?: () => number;
  readonly lockTimeoutMilliseconds?: number;
}

const commitmentPattern = /^[a-f0-9]{64}$/u;
const publisherPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const attemptPattern = /^[0-9a-f]{8}-[0-9a-f-]{27,45}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const maximumEntries = 32;
const defaultLockTimeoutMilliseconds = 5_000;

const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const assertExpiry = (expiresAt: number): void => {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new Error("Artifact publication expiry is malformed");
  }
};

const remember = (
  entries: Map<string, JournalEntry>,
  payloadCommitment: string,
  entry: JournalEntry,
): void => {
  entries.delete(payloadCommitment);
  entries.set(payloadCommitment, entry);
  while (entries.size > maximumEntries) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
};

const opaqueToken = (): string => randomBytes(32).toString("base64url");
const publisherId = (): string => `local_${randomBytes(18).toString("base64url")}`;

const validateEntryMap = (
  value: unknown,
  legacy: boolean,
): Readonly<Record<string, JournalEntry>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact Share publication state is malformed");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maximumEntries) {
    throw new Error("Artifact Share publication state exceeds its bounded capacity");
  }
  const validated: Record<string, JournalEntry> = {};
  for (const [commitment, raw] of entries) {
    if (
      !commitmentPattern.test(commitment) ||
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      throw new Error("Artifact Share publication state is malformed");
    }
    const entry = raw as Record<string, unknown>;
    const expiresAt = legacy ? 0 : entry.expires_at;
    if (
      typeof entry.attempt_id !== "string" ||
      !attemptPattern.test(entry.attempt_id) ||
      typeof entry.share_token !== "string" ||
      !tokenPattern.test(entry.share_token) ||
      typeof entry.updated_at !== "number" ||
      !Number.isSafeInteger(entry.updated_at) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 0
    ) {
      throw new Error("Artifact Share publication state is malformed");
    }
    validated[commitment] = {
      attempt_id: entry.attempt_id,
      share_token: entry.share_token,
      updated_at: entry.updated_at,
      expires_at: expiresAt,
    };
  }
  return validated;
};

const validateState = (value: unknown): JournalState => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact Share publication state is malformed");
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.version !== 1 && candidate.version !== 2) ||
    typeof candidate.publisher_id !== "string" ||
    !publisherPattern.test(candidate.publisher_id)
  ) {
    throw new Error("Artifact Share publication state is malformed");
  }
  const legacy = candidate.version === 1;
  return {
    version: 2,
    publisher_id: candidate.publisher_id,
    pending: validateEntryMap(candidate.pending, legacy),
    acknowledged: legacy ? {} : validateEntryMap(candidate.acknowledged, false),
  };
};

export class MemoryPublicationJournal implements PublicationJournal {
  private readonly publisher = publisherId();
  private readonly pending = new Map<string, JournalEntry>();
  private readonly acknowledged = new Map<string, JournalEntry>();
  private readonly now: () => number;

  public constructor(options: Pick<PublicationJournalOptions, "now"> = {}) {
    this.now = options.now ?? Date.now;
  }

  public async prepare(payloadCommitment: string, expiresAt: number): Promise<PublicationAttempt> {
    assertExpiry(expiresAt);
    const now = this.now();
    if (expiresAt <= now) throw new Error("Artifact publication expiry must be in the future");
    const acknowledged = this.acknowledged.get(payloadCommitment);
    if (acknowledged !== undefined && now < acknowledged.expires_at) {
      return {
        publisherId: this.publisher,
        attemptId: acknowledged.attempt_id,
        shareToken: acknowledged.share_token,
      };
    }
    this.acknowledged.delete(payloadCommitment);
    const pending = this.pending.get(payloadCommitment);
    const entry = pending !== undefined && now < pending.expires_at
      ? pending
      : {
          attempt_id: randomUUID(),
          share_token: opaqueToken(),
          updated_at: now,
          expires_at: expiresAt,
        };
    remember(this.pending, payloadCommitment, entry);
    return {
      publisherId: this.publisher,
      attemptId: entry.attempt_id,
      shareToken: entry.share_token,
    };
  }

  public async acknowledge(
    payloadCommitment: string,
    attemptId: string,
    expiresAt: number,
  ): Promise<void> {
    assertExpiry(expiresAt);
    const pending = this.pending.get(payloadCommitment);
    const acknowledged = this.acknowledged.get(payloadCommitment);
    const entry = pending?.attempt_id === attemptId
      ? pending
      : acknowledged?.attempt_id === attemptId
        ? acknowledged
        : undefined;
    if (entry === undefined) return;
    this.pending.delete(payloadCommitment);
    this.acknowledged.delete(payloadCommitment);
    const now = this.now();
    if (now < expiresAt) {
      remember(this.acknowledged, payloadCommitment, {
        ...entry,
        updated_at: now,
        expires_at: expiresAt,
      });
    }
  }
}

interface DatabaseEntry {
  readonly attempt_id: string;
  readonly share_token: string;
  readonly updated_at: number;
  readonly expires_at: number;
  readonly acknowledged: number;
}

export class FilePublicationJournal implements PublicationJournal {
  private readonly now: () => number;
  private readonly lockTimeoutMilliseconds: number;
  private databasePromise: Promise<DatabaseSync> | undefined;

  public constructor(
    private readonly path: string,
    options: PublicationJournalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? defaultLockTimeoutMilliseconds;
  }

  private async readLegacyState(): Promise<JournalState | undefined> {
    try {
      const source = await readFile(this.path, "utf8");
      if (Buffer.byteLength(source) > 32 * 1024) {
        throw new Error("Artifact Share publication state is too large");
      }
      return validateState(JSON.parse(source));
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async initializeDatabase(): Promise<DatabaseSync> {
    const databasePath = `${this.path}.sqlite3`;
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    const legacy = await this.readLegacyState();
    const databaseFile = await open(databasePath, "a", 0o600);
    await databaseFile.close();
    await chmod(databasePath, 0o600);
    const database = new DatabaseSync(databasePath, {
      timeout: this.lockTimeoutMilliseconds,
    });
    try {
      database.exec("PRAGMA synchronous = FULL");
      database.exec(
        "CREATE TABLE IF NOT EXISTS publication_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS publication_entries (" +
        "payload_commitment TEXT PRIMARY KEY NOT NULL, " +
        "attempt_id TEXT NOT NULL, share_token TEXT NOT NULL, " +
        "updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, " +
        "acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)))",
      );
      database.exec("BEGIN IMMEDIATE");
      const existingPublisher = database
        .prepare("SELECT value FROM publication_metadata WHERE key = 'publisher_id'")
        .get() as { readonly value: string } | undefined;
      if (existingPublisher === undefined) {
        database.prepare(
          "INSERT INTO publication_metadata (key, value) VALUES ('publisher_id', ?)",
        ).run(legacy?.publisher_id ?? publisherId());
      }
      if (legacy !== undefined) {
        const insert = database.prepare(
          "INSERT OR IGNORE INTO publication_entries (" +
          "payload_commitment, attempt_id, share_token, updated_at, expires_at, acknowledged" +
          ") VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const [commitment, entry] of Object.entries(legacy.pending)) {
          insert.run(
            commitment,
            entry.attempt_id,
            entry.share_token,
            entry.updated_at,
            entry.expires_at,
            0,
          );
        }
        for (const [commitment, entry] of Object.entries(legacy.acknowledged)) {
          insert.run(
            commitment,
            entry.attempt_id,
            entry.share_token,
            entry.updated_at,
            entry.expires_at,
            1,
          );
        }
      }
      database.exec("COMMIT");
      return database;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The failure occurred before a transaction was opened.
      }
      database.close();
      throw error;
    }
  }

  private database(): Promise<DatabaseSync> {
    this.databasePromise ??= this.initializeDatabase();
    return this.databasePromise;
  }

  private async transaction<T>(operation: (database: DatabaseSync) => T): Promise<T> {
    const database = await this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }

  private static trimEntries(database: DatabaseSync): void {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM publication_entries")
      .get() as { readonly count: number };
    const overflow = row.count - maximumEntries;
    if (overflow <= 0) return;
    database.prepare(
      "DELETE FROM publication_entries WHERE payload_commitment IN (" +
      "SELECT payload_commitment FROM publication_entries " +
      "ORDER BY updated_at ASC, payload_commitment ASC LIMIT ?)",
    ).run(overflow);
  }

  public prepare(payloadCommitment: string, expiresAt: number): Promise<PublicationAttempt> {
    if (!commitmentPattern.test(payloadCommitment)) {
      return Promise.reject(new Error("Artifact payload commitment is malformed"));
    }
    try {
      assertExpiry(expiresAt);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.transaction((database) => {
      const now = this.now();
      if (expiresAt <= now) throw new Error("Artifact publication expiry must be in the future");
      database.prepare("DELETE FROM publication_entries WHERE expires_at <= ?").run(now);
      const publisher = database
        .prepare("SELECT value FROM publication_metadata WHERE key = 'publisher_id'")
        .get() as { readonly value: string } | undefined;
      if (publisher === undefined || !publisherPattern.test(publisher.value)) {
        throw new Error("Artifact Share publication state is malformed");
      }
      const existing = database.prepare(
        "SELECT attempt_id, share_token, updated_at, expires_at, acknowledged " +
        "FROM publication_entries WHERE payload_commitment = ?",
      ).get(payloadCommitment) as DatabaseEntry | undefined;
      if (existing !== undefined) {
        return {
          publisherId: publisher.value,
          attemptId: existing.attempt_id,
          shareToken: existing.share_token,
        };
      }
      const entry: JournalEntry = {
        attempt_id: randomUUID(),
        share_token: opaqueToken(),
        updated_at: now,
        expires_at: expiresAt,
      };
      database.prepare(
        "INSERT INTO publication_entries (" +
        "payload_commitment, attempt_id, share_token, updated_at, expires_at, acknowledged" +
        ") VALUES (?, ?, ?, ?, ?, 0)",
      ).run(
        payloadCommitment,
        entry.attempt_id,
        entry.share_token,
        entry.updated_at,
        entry.expires_at,
      );
      FilePublicationJournal.trimEntries(database);
      return {
        publisherId: publisher.value,
        attemptId: entry.attempt_id,
        shareToken: entry.share_token,
      };
    });
  }

  public acknowledge(
    payloadCommitment: string,
    attemptId: string,
    expiresAt: number,
  ): Promise<void> {
    if (!commitmentPattern.test(payloadCommitment) || !attemptPattern.test(attemptId)) {
      return Promise.reject(new Error("Artifact publication acknowledgement is malformed"));
    }
    try {
      assertExpiry(expiresAt);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.transaction((database) => {
      const now = this.now();
      database.prepare("DELETE FROM publication_entries WHERE expires_at <= ?").run(now);
      if (now >= expiresAt) {
        database.prepare(
          "DELETE FROM publication_entries WHERE payload_commitment = ? AND attempt_id = ?",
        ).run(payloadCommitment, attemptId);
        return;
      }
      database.prepare(
        "UPDATE publication_entries SET acknowledged = 1, updated_at = ?, expires_at = ? " +
        "WHERE payload_commitment = ? AND attempt_id = ?",
      ).run(now, expiresAt, payloadCommitment, attemptId);
      FilePublicationJournal.trimEntries(database);
    });
  }
}
