import type { ExtractionMetadata, PdfTrust, SupportedMimeType } from "artifact-protocol";

import type { ArtifactRecord, StagedArtifact } from "./artifact-types";

interface ArtifactRow {
  id: string;
  status: "staging" | "active" | "cleanup_pending";
  object_key: string;
  derived_object_key: string | null;
  legacy_derived_object_key: string | null;
  filename: string;
  mime_type: SupportedMimeType;
  byte_size: number;
  sha256: string;
  share_token_hash: string;
  publisher_id: string | null;
  publication_attempt: string | null;
  payload_commitment: string | null;
  created_at: number;
  expires_at: number;
  extraction_status: ExtractionMetadata["status"];
  extractor: string | null;
  extractor_version: string | null;
  page_count: number | null;
  extraction_reason: string | null;
  pdf_trust_status: PdfTrust["status"] | null;
  pdf_trust_reason: string | null;
  pdf_provenance_receipt: string | null;
  cleanup_attempts: number;
  last_cleanup_error: string | null;
}

const extractionFromRow = (row: ArtifactRow): ExtractionMetadata => {
  if (row.extraction_status === "not_applicable") return { status: "not_applicable" };
  if (row.extraction_status === "best_effort") {
    return {
      status: "best_effort",
      extractor: row.extractor ?? "unknown",
      extractor_version: row.extractor_version ?? "unknown",
      page_count: row.page_count ?? 0,
    };
  }
  return {
    status: "unavailable",
    ...(row.extractor === null ? {} : { extractor: row.extractor }),
    ...(row.extractor_version === null ? {} : { extractor_version: row.extractor_version }),
    ...(row.extraction_reason === null ? {} : { reason: row.extraction_reason }),
  };
};

const artifactFromRow = (row: ArtifactRow): ArtifactRecord => ({
  id: row.id,
  status: row.status,
  objectKey: row.object_key,
  derivedObjectKey: row.derived_object_key,
  legacyDerivedObjectKey: row.legacy_derived_object_key,
  filename: row.filename,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  sha256: row.sha256,
  shareTokenHash: row.share_token_hash,
  publisherId: row.publisher_id,
  publicationAttempt: row.publication_attempt,
  payloadCommitment: row.payload_commitment,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  extraction: extractionFromRow(row),
  pdfTrust: (() => {
    if (row.mime_type !== "application/pdf") return { status: "not_applicable" };
    if (row.pdf_trust_status === "controlled" && row.pdf_provenance_receipt !== null) {
      try {
        return {
          status: "controlled",
          receipt: JSON.parse(row.pdf_provenance_receipt),
        } as const;
      } catch {
        return { status: "human_only", reason: "provenance_invalid" } as const;
      }
    }
    return {
      status: "human_only",
      reason: row.pdf_trust_reason === "provenance_missing" || row.pdf_trust_reason === "provenance_invalid"
        ? row.pdf_trust_reason
        : "legacy",
    } as const;
  })(),
  cleanupAttempts: row.cleanup_attempts,
  lastCleanupError: row.last_cleanup_error,
});

export interface ArtifactRepository {
  insertStaging(artifact: StagedArtifact): Promise<void>;
  activate(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  findActiveByShareTokenHash(tokenHash: string): Promise<ArtifactRecord | null>;
  findByPublication(publisherId: string, publicationAttempt: string): Promise<ArtifactRecord | null>;
  findCleanupCandidates(now: number, limit: number): Promise<readonly ArtifactRecord[]>;
  markCleanupPending(id: string): Promise<void>;
  recordCleanupFailure(id: string, message: string): Promise<void>;
  findLegacyDerivedCandidates?(limit: number): Promise<readonly ArtifactRecord[]>;
  clearLegacyDerivedObject?(id: string): Promise<void>;
}

export class D1ArtifactRepository implements ArtifactRepository {
  public constructor(private readonly database: D1Database) {}

  public async insertStaging(artifact: StagedArtifact): Promise<void> {
    const extraction = artifact.extraction;
    await this.database
      .prepare(
        `INSERT INTO artifacts (
          id, status, object_key, derived_object_key, legacy_derived_object_key, filename, mime_type, byte_size, sha256,
          share_token_hash, publisher_id, publication_attempt, payload_commitment,
          created_at, expires_at, extraction_status, extractor,
          extractor_version, page_count, extraction_reason, pdf_trust_status,
          pdf_trust_reason, pdf_provenance_receipt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        artifact.id,
        artifact.status,
        artifact.objectKey,
        artifact.derivedObjectKey,
        artifact.legacyDerivedObjectKey,
        artifact.filename,
        artifact.mimeType,
        artifact.byteSize,
        artifact.sha256,
        artifact.shareTokenHash,
        artifact.publisherId,
        artifact.publicationAttempt,
        artifact.payloadCommitment,
        artifact.createdAt,
        artifact.expiresAt,
        extraction.status,
        "extractor" in extraction ? (extraction.extractor ?? null) : null,
        "extractor_version" in extraction ? (extraction.extractor_version ?? null) : null,
        "page_count" in extraction ? extraction.page_count : null,
        "reason" in extraction ? (extraction.reason ?? null) : null,
        artifact.pdfTrust.status,
        artifact.pdfTrust.status === "human_only" ? artifact.pdfTrust.reason : null,
        artifact.pdfTrust.status === "controlled" ? JSON.stringify(artifact.pdfTrust.receipt) : null,
      )
      .run();
  }

  public async activate(id: string): Promise<void> {
    const result = await this.database
      .prepare("UPDATE artifacts SET status = 'active' WHERE id = ? AND status = 'staging'")
      .bind(id)
      .run();
    if (result.meta.changes !== 1) throw new Error("Failed to activate staged artifact");
  }

  public async delete(id: string): Promise<void> {
    await this.database.prepare("DELETE FROM artifacts WHERE id = ?").bind(id).run();
  }

  public async findActiveByShareTokenHash(tokenHash: string): Promise<ArtifactRecord | null> {
    const row = await this.database
      .prepare("SELECT * FROM artifacts WHERE share_token_hash = ? AND status = 'active'")
      .bind(tokenHash)
      .first<ArtifactRow>();
    return row === null ? null : artifactFromRow(row);
  }

  public async findByPublication(
    publisherId: string,
    publicationAttempt: string,
  ): Promise<ArtifactRecord | null> {
    const row = await this.database
      .prepare("SELECT * FROM artifacts WHERE publisher_id = ? AND publication_attempt = ?")
      .bind(publisherId, publicationAttempt)
      .first<ArtifactRow>();
    return row === null ? null : artifactFromRow(row);
  }

  public async findCleanupCandidates(now: number, limit: number): Promise<readonly ArtifactRecord[]> {
    const staleStagingCutoff = now - 5 * 60 * 1000;
    const result = await this.database
      .prepare(
        `SELECT * FROM artifacts
         WHERE status = 'cleanup_pending'
            OR (status = 'active' AND expires_at <= ?)
            OR (status = 'staging' AND created_at <= ?)
         ORDER BY expires_at ASC
         LIMIT ?`,
      )
      .bind(now, staleStagingCutoff, limit)
      .all<ArtifactRow>();
    return result.results.map(artifactFromRow);
  }

  public async markCleanupPending(id: string): Promise<void> {
    await this.database
      .prepare("UPDATE artifacts SET status = 'cleanup_pending' WHERE id = ?")
      .bind(id)
      .run();
  }

  public async recordCleanupFailure(id: string, message: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE artifacts
         SET status = 'cleanup_pending', cleanup_attempts = cleanup_attempts + 1,
             last_cleanup_error = ?
         WHERE id = ?`,
      )
      .bind(message.slice(0, 500), id)
      .run();
  }

  public async findLegacyDerivedCandidates(limit: number): Promise<readonly ArtifactRecord[]> {
    const result = await this.database
      .prepare("SELECT * FROM artifacts WHERE legacy_derived_object_key IS NOT NULL LIMIT ?")
      .bind(limit)
      .all<ArtifactRow>();
    return result.results.map(artifactFromRow);
  }

  public async clearLegacyDerivedObject(id: string): Promise<void> {
    await this.database
      .prepare("UPDATE artifacts SET legacy_derived_object_key = NULL WHERE id = ?")
      .bind(id)
      .run();
  }
}
