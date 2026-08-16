import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";
import { expireArtifacts } from "../src/server/jobs/expire-artifacts";
import { D1ArtifactRepository } from "../src/server/storage/artifact-repository";
import { ArtifactApplicationService } from "../src/server/storage/artifact-service";
import {
  R2ArtifactObjectStore,
  type ArtifactObjectStore,
} from "../src/server/storage/r2-object-store";

const createdAt = Date.parse("2026-08-16T12:00:00.000Z");
const policy = {
  allowedExpirySeconds: [900],
  maximumArtifactBytes: 1024,
  maximumExpirySeconds: 900,
  maximumSourceChunkBytes: 64,
} as const;

const createArtifact = async () =>
  new ArtifactApplicationService({
    repository: new D1ArtifactRepository(env.ARTIFACT_DB),
    objectStore: new R2ArtifactObjectStore(env.ARTIFACTS),
    policy,
    now: () => createdAt,
  }).create({
    filename: "handoff.md",
    mimeType: "text/markdown",
    bytes: new TextEncoder().encode("# Exact\n"),
    expiresInSeconds: 900,
    extraction: { status: "not_applicable" },
  });

describe("expired artifact cleanup", () => {
  beforeEach(async () => {
    await reset();
    await env.ARTIFACT_DB.exec(ARTIFACT_SCHEMA_SQL);
  });

  it("deletes expired metadata and private objects idempotently", async () => {
    await createArtifact();
    const repository = new D1ArtifactRepository(env.ARTIFACT_DB);
    const objectStore = new R2ArtifactObjectStore(env.ARTIFACTS);

    await expect(
      expireArtifacts({ repository, objectStore, now: createdAt + 900_000 }),
    ).resolves.toEqual({ scanned: 1, deleted: 1, failed: 0 });
    await expect(
      expireArtifacts({ repository, objectStore, now: createdAt + 900_000 }),
    ).resolves.toEqual({ scanned: 0, deleted: 0, failed: 0 });
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(0);
  });

  it("retries a partially failed cleanup without restoring reachability", async () => {
    await createArtifact();
    const repository = new D1ArtifactRepository(env.ARTIFACT_DB);
    const actualStore = new R2ArtifactObjectStore(env.ARTIFACTS);
    let shouldFail = true;
    const flakyStore: ArtifactObjectStore = {
      put: actualStore.put.bind(actualStore),
      get: actualStore.get.bind(actualStore),
      delete: vi.fn(async (key) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("temporary R2 failure");
        }
        await actualStore.delete(key);
      }),
    };

    await expect(
      expireArtifacts({ repository, objectStore: flakyStore, now: createdAt + 900_000 }),
    ).resolves.toEqual({ scanned: 1, deleted: 0, failed: 1 });
    expect(await env.ARTIFACT_DB.prepare("SELECT status FROM artifacts").first("status"))
      .toBe("cleanup_pending");

    await expect(
      expireArtifacts({ repository, objectStore: flakyStore, now: createdAt + 900_000 }),
    ).resolves.toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(0);
  });

  it("removes stale staged rows even when their object is already missing", async () => {
    await env.ARTIFACT_DB.prepare(
      `INSERT INTO artifacts (
        id, status, object_key, filename, mime_type, byte_size, sha256, share_token_hash,
        created_at, expires_at, extraction_status
      ) VALUES (?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, 'not_applicable')`,
    )
      .bind(
        "11111111-1111-4111-8111-111111111111",
        "artifacts/11111111-1111-4111-8111-111111111111/source",
        "missing.md",
        "text/markdown",
        7,
        "a".repeat(64),
        "b".repeat(64),
        createdAt,
        createdAt + 900_000,
      )
      .run();

    await expect(
      expireArtifacts({
        repository: new D1ArtifactRepository(env.ARTIFACT_DB),
        objectStore: new R2ArtifactObjectStore(env.ARTIFACTS),
        now: createdAt + 5 * 60 * 1000,
      }),
    ).resolves.toEqual({ scanned: 1, deleted: 1, failed: 0 });
  });
});
