import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  readonly lockStaleMilliseconds?: number;
  readonly lockRetryMilliseconds?: number;
}

const commitmentPattern = /^[a-f0-9]{64}$/u;
const publisherPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const attemptPattern = /^[0-9a-f]{8}-[0-9a-f-]{27,45}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const maximumEntries = 32;
const defaultLockTimeoutMilliseconds = 5_000;
const defaultLockStaleMilliseconds = 30_000;
const defaultLockRetryMilliseconds = 20;

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

const boundedRecord = (
  entries: Readonly<Record<string, JournalEntry>>,
): Readonly<Record<string, JournalEntry>> =>
  Object.fromEntries(
    Object.entries(entries)
      .sort((left, right) => left[1].updated_at - right[1].updated_at)
      .slice(-maximumEntries),
  );

const activeEntries = (
  entries: Readonly<Record<string, JournalEntry>>,
  now: number,
): Readonly<Record<string, JournalEntry>> =>
  Object.fromEntries(Object.entries(entries).filter(([, entry]) => now < entry.expires_at));

const opaqueToken = (): string => randomBytes(32).toString("base64url");
const publisherId = (): string => `local_${randomBytes(18).toString("base64url")}`;

const emptyState = (): JournalState => ({
  version: 2,
  publisher_id: publisherId(),
  pending: {},
  acknowledged: {},
});

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

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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

export class FilePublicationJournal implements PublicationJournal {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly lockTimeoutMilliseconds: number;
  private readonly lockStaleMilliseconds: number;
  private readonly lockRetryMilliseconds: number;

  public constructor(
    private readonly path: string,
    options: PublicationJournalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? defaultLockTimeoutMilliseconds;
    this.lockStaleMilliseconds = options.lockStaleMilliseconds ?? defaultLockStaleMilliseconds;
    this.lockRetryMilliseconds = options.lockRetryMilliseconds ?? defaultLockRetryMilliseconds;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<JournalState> {
    try {
      const source = await readFile(this.path, "utf8");
      if (Buffer.byteLength(source) > 32 * 1024) {
        throw new Error("Artifact Share publication state is too large");
      }
      return validateState(JSON.parse(source));
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return emptyState();
      throw error;
    }
  }

  private async save(state: JournalState): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async clearStaleLock(lockPath: string): Promise<boolean> {
    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return true;
      throw error;
    }
    if (Date.now() - lockStat.mtimeMs < this.lockStaleMilliseconds) return false;
    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
      if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        ownerPid = owner.pid;
      }
    } catch {
      ownerPid = undefined;
    }
    if (ownerPid !== undefined && processIsAlive(ownerPid)) return false;
    await rm(lockPath, { force: true });
    return true;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMilliseconds;
    let lockHandle: Awaited<ReturnType<typeof open>>;
    while (true) {
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
        try {
          await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: Date.now() })}\n`);
        } catch (error) {
          await lockHandle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        if (await this.clearStaleLock(lockPath)) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for the Artifact Share publication journal lock");
        await delay(Math.min(this.lockRetryMilliseconds, remaining));
      }
    }
    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialized(() => this.withLock(operation));
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
    return this.transaction(async () => {
      const now = this.now();
      if (expiresAt <= now) throw new Error("Artifact publication expiry must be in the future");
      const loaded = await this.load();
      const pending = activeEntries(loaded.pending, now);
      const acknowledged = activeEntries(loaded.acknowledged, now);
      const state = { ...loaded, pending, acknowledged };
      const existing = acknowledged[payloadCommitment] ?? pending[payloadCommitment];
      if (existing !== undefined) {
        if (
          Object.keys(pending).length !== Object.keys(loaded.pending).length ||
          Object.keys(acknowledged).length !== Object.keys(loaded.acknowledged).length
        ) {
          await this.save(state);
        }
        return {
          publisherId: state.publisher_id,
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
      await this.save({
        ...state,
        pending: boundedRecord({ ...pending, [payloadCommitment]: entry }),
      });
      return {
        publisherId: state.publisher_id,
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
    try {
      assertExpiry(expiresAt);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.transaction(async () => {
      const now = this.now();
      const loaded = await this.load();
      const pending = { ...activeEntries(loaded.pending, now) };
      const acknowledged = { ...activeEntries(loaded.acknowledged, now) };
      const matching = pending[payloadCommitment]?.attempt_id === attemptId
        ? pending[payloadCommitment]
        : acknowledged[payloadCommitment]?.attempt_id === attemptId
          ? acknowledged[payloadCommitment]
          : undefined;
      if (matching === undefined) {
        if (
          Object.keys(pending).length !== Object.keys(loaded.pending).length ||
          Object.keys(acknowledged).length !== Object.keys(loaded.acknowledged).length
        ) {
          await this.save({ ...loaded, pending, acknowledged });
        }
        return;
      }
      delete pending[payloadCommitment];
      delete acknowledged[payloadCommitment];
      await this.save({
        ...loaded,
        pending,
        acknowledged: now < expiresAt
          ? boundedRecord({
              ...acknowledged,
              [payloadCommitment]: {
                ...matching,
                updated_at: now,
                expires_at: expiresAt,
              },
            })
          : acknowledged,
      });
    });
  }
}
