import { describe, expect, it, vi } from "vitest";

import type { ArtifactRepository } from "../src/server/storage/artifact-repository";
import { ArtifactApplicationService } from "../src/server/storage/artifact-service";
import type { ArtifactRecord, StagedArtifact } from "../src/server/storage/artifact-types";
import type {
  ArtifactObjectStore,
  StoredObject,
} from "../src/server/storage/r2-object-store";

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

  it("removes source, derived bytes, and staging metadata when activation fails", async () => {
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
        extraction: {
          status: "best_effort",
          extractor: "fixture",
          extractor_version: "1",
          page_count: 1,
        },
        derivedText: new TextEncoder().encode("Page 1"),
      }),
    ).rejects.toThrow("D1 activation unavailable");

    expect(staged?.status).toBe("staging");
    expect(objects.delete).toHaveBeenCalledWith(
      "artifacts/11111111-1111-4111-8111-111111111111/source",
    );
    expect(objects.delete).toHaveBeenCalledWith(
      "artifacts/11111111-1111-4111-8111-111111111111/derived-text",
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

