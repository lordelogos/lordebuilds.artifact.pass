import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PublicationAttempt {
  readonly publisherId: string;
  readonly attemptId: string;
  readonly shareToken: string;
}

export interface PublicationJournal {
  prepare(payloadCommitment: string): Promise<PublicationAttempt>;
  acknowledge(payloadCommitment: string, attemptId: string): Promise<void>;
}

interface JournalEntry {
  readonly attempt_id: string;
  readonly share_token: string;
  readonly updated_at: number;
}

interface JournalState {
  readonly version: 1;
  readonly publisher_id: string;
  readonly pending: Readonly<Record<string, JournalEntry>>;
}

const commitmentPattern = /^[a-f0-9]{64}$/u;
const publisherPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const attemptPattern = /^[0-9a-f]{8}-[0-9a-f-]{27,45}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const maximumPendingEntries = 32;

const remember = (
  entries: Map<string, JournalEntry>,
  payloadCommitment: string,
  entry: JournalEntry,
): void => {
  entries.delete(payloadCommitment);
  entries.set(payloadCommitment, entry);
  while (entries.size > maximumPendingEntries) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
};

const opaqueToken = (): string => randomBytes(32).toString("base64url");
const publisherId = (): string => `local_${randomBytes(18).toString("base64url")}`;

const emptyState = (): JournalState => ({
  version: 1,
  publisher_id: publisherId(),
  pending: {},
});

const validateState = (value: unknown): JournalState => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact Share publication state is malformed");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.publisher_id !== "string" ||
    !publisherPattern.test(candidate.publisher_id) ||
    candidate.pending === null ||
    typeof candidate.pending !== "object" ||
    Array.isArray(candidate.pending)
  ) {
    throw new Error("Artifact Share publication state is malformed");
  }
  const entries = Object.entries(candidate.pending as Record<string, unknown>);
  if (entries.length > maximumPendingEntries) {
    throw new Error("Artifact Share publication state exceeds its bounded capacity");
  }
  const pending: Record<string, JournalEntry> = {};
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
    if (
      typeof entry.attempt_id !== "string" ||
      !attemptPattern.test(entry.attempt_id) ||
      typeof entry.share_token !== "string" ||
      !tokenPattern.test(entry.share_token) ||
      typeof entry.updated_at !== "number" ||
      !Number.isSafeInteger(entry.updated_at)
    ) {
      throw new Error("Artifact Share publication state is malformed");
    }
    pending[commitment] = {
      attempt_id: entry.attempt_id,
      share_token: entry.share_token,
      updated_at: entry.updated_at,
    };
  }
  return { version: 1, publisher_id: candidate.publisher_id, pending };
};

export class MemoryPublicationJournal implements PublicationJournal {
  private readonly publisher = publisherId();
  private readonly pending = new Map<string, JournalEntry>();

  public async prepare(payloadCommitment: string): Promise<PublicationAttempt> {
    const existing = this.pending.get(payloadCommitment);
    const entry = existing ?? {
      attempt_id: randomUUID(),
      share_token: opaqueToken(),
      updated_at: Date.now(),
    };
    this.pending.set(payloadCommitment, entry);
    return {
      publisherId: this.publisher,
      attemptId: entry.attempt_id,
      shareToken: entry.share_token,
    };
  }

  public async acknowledge(payloadCommitment: string, attemptId: string): Promise<void> {
    if (this.pending.get(payloadCommitment)?.attempt_id !== attemptId) return;
    // Keep the acknowledged attempt for same-session repeated lifecycle events.
  }
}

export class FilePublicationJournal implements PublicationJournal {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly acknowledged = new Map<string, JournalEntry>();

  public constructor(private readonly path: string) {}

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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private async save(state: JournalState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await chmod(this.path, 0o600);
  }

  public prepare(payloadCommitment: string): Promise<PublicationAttempt> {
    if (!commitmentPattern.test(payloadCommitment)) {
      return Promise.reject(new Error("Artifact payload commitment is malformed"));
    }
    return this.serialized(async () => {
      const acknowledged = this.acknowledged.get(payloadCommitment);
      if (acknowledged !== undefined) {
        return {
          publisherId: (await this.load()).publisher_id,
          attemptId: acknowledged.attempt_id,
          shareToken: acknowledged.share_token,
        };
      }
      const state = await this.load();
      const existing = state.pending[payloadCommitment];
      const entry = existing ?? {
        attempt_id: randomUUID(),
        share_token: opaqueToken(),
        updated_at: Date.now(),
      };
      if (existing === undefined) {
        const pendingEntries = Object.entries(state.pending)
          .sort((left, right) => left[1].updated_at - right[1].updated_at)
          .slice(-(maximumPendingEntries - 1));
        await this.save({
          ...state,
          pending: Object.fromEntries([...pendingEntries, [payloadCommitment, entry]]),
        });
      }
      return {
        publisherId: state.publisher_id,
        attemptId: entry.attempt_id,
        shareToken: entry.share_token,
      };
    });
  }

  public acknowledge(payloadCommitment: string, attemptId: string): Promise<void> {
    return this.serialized(async () => {
      const state = await this.load();
      const acknowledged = state.pending[payloadCommitment];
      if (acknowledged?.attempt_id !== attemptId) return;
      remember(this.acknowledged, payloadCommitment, acknowledged);
      const pending = { ...state.pending };
      delete pending[payloadCommitment];
      await this.save({ ...state, pending });
    });
  }
}
