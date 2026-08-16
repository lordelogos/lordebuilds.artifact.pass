import { describe, expect, it } from "vitest";

import { MemoryPublicationJournal } from "../src/state/publication-journal";

describe("MemoryPublicationJournal", () => {
  it("bounds retained same-session publication attempts", async () => {
    const journal = new MemoryPublicationJournal();
    const oldestCommitment = "0".repeat(64);
    const oldest = await journal.prepare(oldestCommitment);

    for (let index = 1; index <= 32; index += 1) {
      await journal.prepare(index.toString(16).padStart(64, "0"));
    }

    const replacement = await journal.prepare(oldestCommitment);
    expect(replacement.attemptId).not.toBe(oldest.attemptId);
    expect(replacement.shareToken).not.toBe(oldest.shareToken);
  });
});
