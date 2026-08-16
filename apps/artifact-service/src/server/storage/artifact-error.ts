export type ArtifactErrorCode =
  | "unsupported_media_type"
  | "mime_mismatch"
  | "artifact_too_large"
  | "malformed_upload"
  | "invalid_expiry"
  | "incompatible_protocol_version"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "expired"
  | "invalid_cursor"
  | "internal_error";

export class ArtifactError extends Error {
  public constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}
