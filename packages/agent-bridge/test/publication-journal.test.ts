import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      acknowledged?: Readonly<Record<string, { readonly expires_at?: number }>>;
    };
    expect(persisted.acknowledged?.[commitment]?.expires_at).toBe(4_000);

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
    const journals = [new FilePublicationJournal(path), new FilePublicationJournal(path)];
    const commitments = Array.from({ length: 16 }, (_, index) =>
      index.toString(16).padStart(64, "0")
    );
    const expiresAt = Date.now() + 60_000;

    const attempts = await Promise.all(commitments.map((commitment, index) =>
      journals[index % journals.length]!.prepare(commitment, expiresAt)
    ));
    const verifier = new FilePublicationJournal(path);
    const recovered = await Promise.all(commitments.map((commitment) =>
      verifier.prepare(commitment, expiresAt)
    ));

    expect(recovered).toEqual(attempts);
    expect(new Set(recovered.map((attempt) => attempt.publisherId)).size).toBe(1);
  });

  it("recovers a stale lock owned by a dead process", async () => {
    const root = await workspace();
    const path = join(root, "publication-state.json");
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 999_999 }));
    const journal = new FilePublicationJournal(path, {
      lockStaleMilliseconds: 0,
      lockTimeoutMilliseconds: 100,
      lockRetryMilliseconds: 1,
    });

    await expect(journal.prepare("c".repeat(64), Date.now() + 60_000)).resolves.toMatchObject({
      publisherId: expect.stringMatching(/^local_/u),
    });
  });

  it("bounds lock acquisition when the owner is still alive", async () => {
    const root = await workspace();
    const path = join(root, "publication-state.json");
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid }));
    const journal = new FilePublicationJournal(path, {
      lockStaleMilliseconds: 0,
      lockTimeoutMilliseconds: 20,
      lockRetryMilliseconds: 1,
    });

    await expect(journal.prepare("d".repeat(64), Date.now() + 60_000))
      .rejects.toThrow(/Timed out.*journal lock/u);
  });
});
