import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  FilePublicationJournal,
  MemoryPublicationJournal,
} from "../src/state/publication-journal";

const createdDirectories: string[] = [];

const workspace = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-share-publication-journal-"));
  createdDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map(async (directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("MemoryPublicationJournal", () => {
  it("bounds retained same-session publication attempts", async () => {
    const journal = new MemoryPublicationJournal({ now: () => 1_000 });
    const oldestCommitment = "0".repeat(64);
    const oldest = await journal.prepare(oldestCommitment, 10_000);

    for (let index = 1; index <= 32; index += 1) {
      await journal.prepare(index.toString(16).padStart(64, "0"), 10_000);
    }

    const replacement = await journal.prepare(oldestCommitment, 10_000);
    expect(replacement.attemptId).not.toBe(oldest.attemptId);
    expect(replacement.shareToken).not.toBe(oldest.shareToken);
  });

  it("reuses acknowledged attempts only before their exact expiry", async () => {
    let now = 1_000;
    const journal = new MemoryPublicationJournal({ now: () => now });
    const commitment = "a".repeat(64);
    const original = await journal.prepare(commitment, 5_000);
    await journal.acknowledge(commitment, original.attemptId, 4_000);

    now = 3_999;
    await expect(journal.prepare(commitment, 8_000)).resolves.toEqual(original);

    now = 4_000;
    const replacement = await journal.prepare(commitment, 8_000);
    expect(replacement.attemptId).not.toBe(original.attemptId);
    expect(replacement.shareToken).not.toBe(original.shareToken);
  });
});

describe("FilePublicationJournal", () => {
  it("persists acknowledgements across restart until expiry, then rotates", async () => {
    const root = await workspace();
    const path = join(root, "publication-state.json");
    const commitment = "b".repeat(64);
    let now = 1_000;
    const options = { now: () => now };
    const originalJournal = new FilePublicationJournal(path, options);
    const original = await originalJournal.prepare(commitment, 5_000);
    await originalJournal.acknowledge(commitment, original.attemptId, 4_000);

    const persistedDatabase = new DatabaseSync(`${path}.sqlite3`, { readOnly: true });
    const persisted = persistedDatabase.prepare(
      "SELECT expires_at, acknowledged FROM publication_entries WHERE payload_commitment = ?",
    ).get(commitment);
    persistedDatabase.close();
    expect(persisted).toEqual({ expires_at: 4_000, acknowledged: 1 });

    now = 3_999;
    const restarted = new FilePublicationJournal(path, options);
    await expect(restarted.prepare(commitment, 8_000)).resolves.toEqual(original);

    now = 4_000;
    const afterExpiry = new FilePublicationJournal(path, options);
    const replacement = await afterExpiry.prepare(commitment, 8_000);
    expect(replacement.attemptId).not.toBe(original.attemptId);
    expect(replacement.shareToken).not.toBe(original.shareToken);
  });

  it("preserves concurrent updates from separate journal instances", async () => {
    const root = await workspace();
    const path = join(root, "publication-state.json");
    const commitments = Array.from({ length: 16 }, (_, index) =>
      index.toString(16).padStart(64, "0")
    );
    const expiresAt = Date.now() + 60_000;

    const attempts = await Promise.all(commitments.map((commitment) =>
      new FilePublicationJournal(path).prepare(commitment, expiresAt)
    ));
    const verifier = new FilePublicationJournal(path);
    const recovered = await Promise.all(commitments.map((commitment) =>
      verifier.prepare(commitment, expiresAt)
    ));

    expect(recovered).toEqual(attempts);
    expect(new Set(recovered.map((attempt) => attempt.publisherId)).size).toBe(1);
  });

  it("imports the previous bounded JSON journal without changing its publisher or attempt", async () => {
    const root = await workspace();
    const path = join(root, "publication-state.json");
    const commitment = "c".repeat(64);
    const attemptId = crypto.randomUUID();
    const shareToken = "C".repeat(43);
    const expiresAt = Date.now() + 60_000;
    await writeFile(path, JSON.stringify({
      version: 2,
      publisher_id: "local_legacy-publisher",
      pending: {},
      acknowledged: {
        [commitment]: {
          attempt_id: attemptId,
          share_token: shareToken,
          updated_at: Date.now(),
          expires_at: expiresAt,
        },
      },
    }));

    await expect(new FilePublicationJournal(path).prepare(commitment, expiresAt + 1_000))
      .resolves.toEqual({
        publisherId: "local_legacy-publisher",
        attemptId,
        shareToken,
      });
  });

  it("bounds SQLite transaction acquisition when another connection holds the writer lock", async () => {
    const root = await workspace();
    const path = join(root, "publication-state.json");
    await new FilePublicationJournal(path).prepare("d".repeat(64), Date.now() + 60_000);
    const blocker = new DatabaseSync(`${path}.sqlite3`);
    blocker.exec("BEGIN IMMEDIATE");
    const journal = new FilePublicationJournal(path, { lockTimeoutMilliseconds: 20 });

    await expect(journal.prepare("e".repeat(64), Date.now() + 60_000))
      .rejects.toThrow(/locked/iu);
    blocker.exec("ROLLBACK");
    blocker.close();
  });
});
