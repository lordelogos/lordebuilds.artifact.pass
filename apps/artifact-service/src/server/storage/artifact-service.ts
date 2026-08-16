import {
  PROTOCOL_VERSION,
  artifactManifestSchema,
  type ArtifactManifest,
} from "artifact-protocol";

import { ArtifactError } from "./artifact-error";
import type { ArtifactRepository } from "./artifact-repository";
import type {
  ArtifactPolicy,
  ArtifactRecord,
  ArtifactUploadInput,
  CreatedArtifact,
  StagedArtifact,
} from "./artifact-types";
import { createShareToken, hashShareToken, sha256 } from "./crypto";
import type { ArtifactObjectStore, StoredObject } from "./r2-object-store";
import { validateArtifactUpload } from "./validation";

export interface ArtifactServiceOptions {
  readonly repository: ArtifactRepository;
  readonly objectStore: ArtifactObjectStore;
  readonly policy: ArtifactPolicy;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly createToken?: () => string;
}

export const artifactRecordToManifest = (artifact: ArtifactRecord): ArtifactManifest =>
  artifactManifestSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    artifact_id: artifact.id,
    filename: artifact.filename,
    mime_type: artifact.mimeType,
    byte_size: artifact.byteSize,
    sha256: artifact.sha256,
    created_at: new Date(artifact.createdAt).toISOString(),
    expires_at: new Date(artifact.expiresAt).toISOString(),
    extraction: artifact.extraction,
  });

const notFound = (): ArtifactError =>
  new ArtifactError("not_found", "Artifact is unavailable", 404);

export class ArtifactApplicationService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createToken: () => string;

  public constructor(private readonly options: ArtifactServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? crypto.randomUUID.bind(crypto);
    this.createToken = options.createToken ?? createShareToken;
  }

  public async create(input: ArtifactUploadInput): Promise<CreatedArtifact> {
    const mimeType = validateArtifactUpload(input, this.options.policy);
    const id = this.createId();
    const shareToken = this.createToken();
    const shareTokenHash = await hashShareToken(shareToken);
    const checksum = await sha256(input.bytes);
    const createdAt = this.now();
    const objectKey = `artifacts/${id}/source`;
    const derivedObjectKey =
      input.derivedText === undefined ? null : `artifacts/${id}/derived-text`;
    const staged: StagedArtifact = {
      id,
      status: "staging",
      objectKey,
      derivedObjectKey,
      filename: input.filename,
      mimeType,
      byteSize: input.bytes.byteLength,
      sha256: checksum,
      shareTokenHash,
      createdAt,
      expiresAt: createdAt + input.expiresInSeconds * 1000,
      extraction: input.extraction,
      cleanupAttempts: 0,
      lastCleanupError: null,
    };

    await this.options.repository.insertStaging(staged);
    try {
      await this.options.objectStore.put(objectKey, input.bytes, mimeType);
      if (input.derivedText !== undefined && derivedObjectKey !== null) {
        await this.options.objectStore.put(
          derivedObjectKey,
          input.derivedText,
          "text/plain; charset=utf-8",
        );
      }
      await this.options.repository.activate(id);
    } catch (error) {
      await Promise.allSettled([
        this.options.objectStore.delete(objectKey),
        ...(derivedObjectKey === null
          ? []
          : [this.options.objectStore.delete(derivedObjectKey)]),
      ]);
      await this.options.repository.delete(id).catch(() => undefined);
      throw error;
    }

    return {
      manifest: artifactRecordToManifest({ ...staged, status: "active" }),
      shareToken,
    };
  }

  public async resolve(shareToken: string): Promise<ArtifactRecord> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(shareToken)) throw notFound();
    const artifact = await this.options.repository.findActiveByShareTokenHash(
      await hashShareToken(shareToken),
    );
    if (artifact === null || this.now() >= artifact.expiresAt) throw notFound();
    return artifact;
  }

  public async getSource(
    artifact: ArtifactRecord,
    range?: { readonly offset: number; readonly length: number },
  ): Promise<StoredObject> {
    const object = await this.options.objectStore.get(artifact.objectKey, range);
    if (object !== null) return object;
    await this.options.repository.markCleanupPending(artifact.id).catch(() => undefined);
    throw notFound();
  }

  public async getDerived(artifact: ArtifactRecord): Promise<StoredObject> {
    if (artifact.derivedObjectKey === null) throw notFound();
    const object = await this.options.objectStore.get(artifact.derivedObjectKey);
    if (object !== null) return object;
    await this.options.repository.markCleanupPending(artifact.id).catch(() => undefined);
    throw notFound();
  }
}

