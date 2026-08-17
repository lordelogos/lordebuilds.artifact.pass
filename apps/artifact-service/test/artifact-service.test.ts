import { describe, expect, it, vi } from "vitest";
import { createPayloadCommitment } from "../../../scripts/publication-commitment.mjs";

import type { ArtifactRepository } from "../src/server/storage/artifact-repository";
import { ArtifactApplicationService } from "../src/server/storage/artifact-service";
import type { ArtifactRecord, StagedArtifact } from "../src/server/storage/artifact-types";
import type {
  ArtifactObjectStore,
  StoredObject,
} from "../src/server/storage/r2-object-store";
import { hashShareToken } from "../src/server/storage/crypto";

const policy = {
  allowedExpirySeconds: [900],
  maximumArtifactBytes: 1024,
  maximumExpirySeconds: 900,
  maximumSourceChunkBytes: 64,
} as const;

const repository = (overrides: Partial<ArtifactRepository> = {}): ArtifactRepository => ({
  insertStaging: vi.fn(async () => undefined),
  activate: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  findActiveByShareTokenHash: vi.fn(async () => null),
  findByPublication: vi.fn(async () => null),
  findCleanupCandidates: vi.fn(async () => []),
  markCleanupPending: vi.fn(async () => undefined),
  recordCleanupFailure: vi.fn(async () => undefined),
  ...overrides,
});

const objectStore = (overrides: Partial<ArtifactObjectStore> = {}): ArtifactObjectStore => ({
  put: vi.fn(async () => undefined),
  get: vi.fn(async (): Promise<StoredObject | null> => null),
  delete: vi.fn(async () => undefined),
  ...overrides,
});

const markdownInput = {
  filename: "handoff.md",
  mimeType: "text/markdown",
  bytes: new TextEncoder().encode("# Exact\n"),
  expiresInSeconds: 900,
  extraction: { status: "not_applicable" as const },
};

describe("staged artifact writes", () => {
  it("waits for a matching concurrent publication to activate and returns its result", async () => {
    const publicationAttempt = crypto.randomUUID();
    const shareToken = "A".repeat(43);
    const payloadCommitment = await createPayloadCommitment({
      bytes: markdownInput.bytes,
      expiresInSeconds: markdownInput.expiresInSeconds,
      filename: markdownInput.filename,
      mimeType: markdownInput.mimeType,
    });
    const input = {
      ...markdownInput,
      publisherId: "local:publisher-01",
      publicationAttempt,
      payloadCommitment,
      shareToken,
    };
    let record: ArtifactRecord | null = null;
    let releaseObjectWrite: (() => void) | undefined;
    const objectWrite = new Promise<void>((resolve) => {
      releaseObjectWrite = resolve;
    });
    let activated: (() => void) | undefined;
    const activation = new Promise<void>((resolve) => {
      activated = resolve;
    });
    const metadata = repository({
      findByPublication: vi.fn(async () => record),
      insertStaging: vi.fn(async (artifact) => {
        record = artifact;
      }),
      activate: vi.fn(async () => {
        record = record === null ? null : { ...record, status: "active" };
        activated?.();
      }),
    });
    const objects = objectStore({ put: vi.fn(async () => objectWrite) });
    const service = new ArtifactApplicationService({
      repository: metadata,
      objectStore: objects,
      policy,
      createId: () => "11111111-1111-4111-8111-111111111111",
      now: () => Date.parse("2026-08-16T12:00:00.000Z"),
      waitForPublication: async () => activation,
    });

    const winner = service.create(input);
    await vi.waitFor(() => expect(record?.status).toBe("staging"));
    const retry = service.create(input);
    releaseObjectWrite?.();

    const [created, recovered] = await Promise.all([winner, retry]);
    expect(created.created).toBe(true);
    expect(recovered.created).toBe(false);
    expect(recovered.shareToken).toBe(shareToken);
    expect(metadata.insertStaging).toHaveBeenCalledTimes(1);
    expect(objects.put).toHaveBeenCalledTimes(1);
    expect((record as ArtifactRecord | null)?.shareTokenHash).toBe(await hashShareToken(shareToken));
  });

  it("does not write an object when the staging metadata insert fails", async () => {
    const metadata = repository({
      insertStaging: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });
    const objects = objectStore();
    const service = new ArtifactApplicationService({
      repository: metadata,
      objectStore: objects,
      policy,
    });

    await expect(service.create(markdownInput)).rejects.toThrow("D1 unavailable");
    expect(objects.put).not.toHaveBeenCalled();
  });

  it("removes source bytes and staging metadata when activation fails", async () => {
    let staged: StagedArtifact | undefined;
    const metadata = repository({
      insertStaging: vi.fn(async (artifact) => {
        staged = artifact;
      }),
      activate: vi.fn(async () => {
        throw new Error("D1 activation unavailable");
      }),
    });
    const objects = objectStore();
    const service = new ArtifactApplicationService({
      repository: metadata,
      objectStore: objects,
      policy,
      createId: () => "11111111-1111-4111-8111-111111111111",
      createToken: () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      now: () => Date.parse("2026-08-16T12:00:00.000Z"),
    });

    await expect(
      service.create({
        filename: "report.pdf",
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.7\nfixture"),
        expiresInSeconds: 900,
        extraction: { status: "unavailable", reason: "Human-only fixture" },
      }),
    ).rejects.toThrow("D1 activation unavailable");

    expect(staged?.status).toBe("staging");
    expect(objects.delete).toHaveBeenCalledWith(
      "artifacts/11111111-1111-4111-8111-111111111111/source",
    );
    expect(metadata.delete).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("never resolves staging or cleanup-pending records through the service contract", async () => {
    const inactive = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "staging",
    } as ArtifactRecord;
    const metadata = repository({
      findActiveByShareTokenHash: vi.fn(async () =>
        inactive.status === "active" ? inactive : null,
      ),
    });
    const service = new ArtifactApplicationService({
      repository: metadata,
      objectStore: objectStore(),
      policy,
    });

    await expect(
      service.resolve("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
