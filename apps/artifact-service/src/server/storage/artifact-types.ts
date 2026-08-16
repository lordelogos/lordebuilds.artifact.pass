import type {
  ArtifactManifest,
  ExtractionMetadata,
  SupportedMimeType,
} from "artifact-protocol";

export type ArtifactStatus = "staging" | "active" | "cleanup_pending";

export interface ArtifactRecord {
  readonly id: string;
  readonly status: ArtifactStatus;
  readonly objectKey: string;
  readonly derivedObjectKey: string | null;
  readonly filename: string;
  readonly mimeType: SupportedMimeType;
  readonly byteSize: number;
  readonly sha256: string;
  readonly shareTokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly extraction: ExtractionMetadata;
  readonly cleanupAttempts: number;
  readonly lastCleanupError: string | null;
}

export interface StagedArtifact extends ArtifactRecord {
  readonly status: "staging";
}

export interface ArtifactUploadInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly expiresInSeconds: number;
  readonly extraction: ExtractionMetadata;
  readonly derivedText?: Uint8Array;
}

export interface CreatedArtifact {
  readonly manifest: ArtifactManifest;
  readonly shareToken: string;
}

export interface ArtifactPolicy {
  readonly allowedExpirySeconds: readonly number[];
  readonly maximumArtifactBytes: number;
  readonly maximumExpirySeconds: number;
  readonly maximumSourceChunkBytes: number;
}

