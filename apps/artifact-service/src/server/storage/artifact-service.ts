import {
  PROTOCOL_VERSION,
  artifactManifestSchema,
  type ArtifactManifest,
} from "artifact-protocol";
import { createPayloadCommitmentFromSourceHash } from "../../../../../scripts/publication-commitment.mjs";

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
import { verifyPdfProvenance } from "./pdf-provenance";
import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";

export interface ArtifactServiceOptions {
  readonly repository: ArtifactRepository;
  readonly objectStore: ArtifactObjectStore;
  readonly policy: ArtifactPolicy;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly createToken?: () => string;
  readonly publicationRecoveryAttempts?: number;
  readonly waitForPublication?: () => Promise<void>;
  readonly provenanceBindings?: Pick<ArtifactServiceBindings, "PDF_PROVENANCE_PUBLIC_KEYS" | "PDF_PROVENANCE_RENDERERS">;
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
    pdf_trust: artifact.pdfTrust,
  });

const notFound = (): ArtifactError =>
  new ArtifactError("not_found", "Artifact is unavailable", 404);

interface PublicationRetry {
  readonly publisherId: string;
  readonly publicationAttempt: string;
  readonly payloadCommitment: string;
  readonly shareToken: string;
}

const publicationRetryFromInput = (input: ArtifactUploadInput): PublicationRetry | undefined => {
  if (
    input.publisherId !== undefined &&
    input.publicationAttempt !== undefined &&
    input.payloadCommitment !== undefined &&
    input.shareToken !== undefined
  ) {
    return {
      publisherId: input.publisherId,
      publicationAttempt: input.publicationAttempt,
      payloadCommitment: input.payloadCommitment,
      shareToken: input.shareToken,
    };
  }
  if (
    input.publisherId !== undefined ||
    input.publicationAttempt !== undefined ||
    input.payloadCommitment !== undefined ||
    input.shareToken !== undefined
  ) {
    throw new ArtifactError("malformed_upload", "Publication retry fields must be complete", 400);
  }
  return undefined;
};

export class ArtifactApplicationService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly publicationRecoveryAttempts: number;
  private readonly waitForPublication: () => Promise<void>;

  public constructor(private readonly options: ArtifactServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? crypto.randomUUID.bind(crypto);
    this.createToken = options.createToken ?? createShareToken;
    this.publicationRecoveryAttempts = options.publicationRecoveryAttempts ?? 100;
    this.waitForPublication = options.waitForPublication ?? (async () => new Promise((resolve) => {
      setTimeout(resolve, 50);
    }));
  }

  public async create(input: ArtifactUploadInput): Promise<CreatedArtifact> {
    const declaredPdfTrust = input.pdfTrust ?? (
      input.mimeType.toLowerCase() === "application/pdf"
        ? { status: "human_only" as const, reason: "provenance_missing" as const }
        : { status: "not_applicable" as const }
    );
    const normalizedInput = { ...input, pdfTrust: declaredPdfTrust };
    const mimeType = validateArtifactUpload(normalizedInput, this.options.policy);
    const publication = publicationRetryFromInput(input);
    const [checksum, derivedSha256] = await Promise.all([
      sha256(input.bytes),
      input.derivedText === undefined ? Promise.resolve(null) : sha256(input.derivedText),
    ]);
    let pdfTrust = declaredPdfTrust;
    if (pdfTrust.status === "controlled") {
      if (derivedSha256 === null) {
        throw new ArtifactError("malformed_upload", "Controlled PDF source is required", 400);
      }
      const verified = await verifyPdfProvenance(
        pdfTrust.receipt,
        derivedSha256,
        checksum,
        this.options.provenanceBindings ?? {},
      );
      if (verified === null) {
        throw new ArtifactError("malformed_upload", "PDF provenance could not be verified", 400);
      }
      pdfTrust = { status: "controlled", receipt: verified };
    }
    if (publication !== undefined) {
      if (
        !/^[A-Za-z0-9:_-]{8,255}$/u.test(publication.publisherId) ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27,45}$/u.test(publication.publicationAttempt) ||
        !/^[a-f0-9]{64}$/u.test(publication.payloadCommitment) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(publication.shareToken)
      ) {
        throw new ArtifactError("malformed_upload", "Publication retry fields are malformed", 400);
      }
      const expectedCommitment = await createPayloadCommitmentFromSourceHash({
        derivedHash: derivedSha256,
        expiresInSeconds: input.expiresInSeconds,
        extraction: input.extraction,
        filename: input.filename,
        mimeType,
        pdfTrust,
        sourceHash: checksum,
      });
      if (expectedCommitment !== publication.payloadCommitment) {
        throw new ArtifactError("malformed_upload", "Payload commitment does not match the upload", 400);
      }
      const existing = await this.options.repository.findByPublication(
        publication.publisherId,
        publication.publicationAttempt,
      );
      if (existing !== null) return this.recoverPublication(existing, publication);
    }
    const id = this.createId();
    const shareToken = publication?.shareToken ?? this.createToken();
    const shareTokenHash = await hashShareToken(shareToken);
    const createdAt = this.now();
    const objectKey = `artifacts/${id}/source`;
    const derivedObjectKey =
      input.derivedText === undefined ? null : `artifacts/${id}/derived-text`;
    const staged: StagedArtifact = {
      id,
      status: "staging",
      objectKey,
      derivedObjectKey,
      legacyDerivedObjectKey: null,
      filename: input.filename,
      mimeType,
      byteSize: input.bytes.byteLength,
      sha256: checksum,
      shareTokenHash,
      publisherId: publication?.publisherId ?? null,
      publicationAttempt: publication?.publicationAttempt ?? null,
      payloadCommitment: publication?.payloadCommitment ?? null,
      createdAt,
      expiresAt: createdAt + input.expiresInSeconds * 1000,
      extraction: input.extraction,
      pdfTrust,
      cleanupAttempts: 0,
      lastCleanupError: null,
    };

    try {
      await this.options.repository.insertStaging(staged);
    } catch (error) {
      if (publication !== undefined) {
        const raced = await this.options.repository.findByPublication(
          publication.publisherId,
          publication.publicationAttempt,
        );
        if (raced !== null) return this.recoverPublication(raced, publication);
      }
      throw error;
    }
    try {
      await this.options.objectStore.put(objectKey, input.bytes, mimeType);
      if (input.derivedText !== undefined && derivedObjectKey !== null) {
        if (derivedSha256 === null) throw new Error("Derived artifact checksum is unavailable");
        await this.options.objectStore.put(
          derivedObjectKey,
          input.derivedText,
          "text/plain; charset=utf-8",
          { sha256: derivedSha256 },
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
      created: true,
    };
  }

  private async recoverPublication(
    existing: ArtifactRecord,
    publication: PublicationRetry,
  ): Promise<CreatedArtifact> {
    const shareTokenHash = await hashShareToken(publication.shareToken);
    let candidate: ArtifactRecord | null = existing;
    for (let attempt = 0; attempt <= this.publicationRecoveryAttempts; attempt += 1) {
      if (
        candidate === null ||
        this.now() >= candidate.expiresAt ||
        candidate.payloadCommitment !== publication.payloadCommitment ||
        candidate.shareTokenHash !== shareTokenHash
      ) {
        break;
      }
      if (candidate.status === "active") {
        return {
          manifest: artifactRecordToManifest(candidate),
          shareToken: publication.shareToken,
          created: false,
        };
      }
      if (candidate.status !== "staging" || attempt === this.publicationRecoveryAttempts) break;
      await this.waitForPublication();
      candidate = await this.options.repository.findByPublication(
        publication.publisherId,
        publication.publicationAttempt,
      );
    }
    throw new ArtifactError(
      "malformed_upload",
      "Publication attempt conflicts with an existing artifact",
      409,
    );
  }

  public async resolve(shareToken: string): Promise<ArtifactRecord> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(shareToken)) throw notFound();
    const artifact = await this.options.repository.findActiveByShareTokenHash(
      await hashShareToken(shareToken),
    );
    if (artifact === null || this.now() >= artifact.expiresAt) throw notFound();
    if (artifact.pdfTrust.status === "controlled") {
      const verified = await verifyPdfProvenance(
        artifact.pdfTrust.receipt,
        artifact.pdfTrust.receipt.source_sha256,
        artifact.sha256,
        this.options.provenanceBindings ?? {},
      );
      if (verified === null) {
        return { ...artifact, pdfTrust: { status: "human_only", reason: "provenance_invalid" } };
      }
    }
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

  public async getDerived(
    artifact: ArtifactRecord,
    range?: { readonly offset: number; readonly length: number },
  ): Promise<StoredObject> {
    if (artifact.pdfTrust.status !== "controlled" || artifact.derivedObjectKey === null) throw notFound();
    const object = await this.options.objectStore.get(artifact.derivedObjectKey, range);
    if (object !== null) {
      if (object.metadata?.sha256 !== artifact.pdfTrust.receipt.source_sha256) throw notFound();
      return object;
    }
    await this.options.repository.markCleanupPending(artifact.id).catch(() => undefined);
    throw notFound();
  }
}
