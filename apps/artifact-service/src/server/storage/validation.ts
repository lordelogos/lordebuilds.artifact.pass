import {
  DEFAULT_EXPIRY_POLICY,
  PROTOCOL_MAX_ARTIFACT_BYTES,
  PROTOCOL_MAX_EXPIRY_SECONDS,
  PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
  SUPPORTED_MIME_TYPES,
  type ExtractionMetadata,
  type SupportedMimeType,
} from "artifact-protocol";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import { findFirstSensitiveContent } from "../../../../../scripts/security-patterns.mjs";
import { ArtifactError } from "./artifact-error";
import type { ArtifactPolicy, ArtifactUploadInput } from "./artifact-types";

const extensionByMime: Record<SupportedMimeType, ReadonlySet<string>> = {
  "text/html": new Set(["html", "htm"]),
  "text/markdown": new Set(["md", "markdown"]),
  "application/pdf": new Set(["pdf"]),
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error("Artifact policy values must be positive integers");
  return Number(value);
};

export const artifactPolicyFromBindings = (
  bindings: ArtifactServiceBindings,
): ArtifactPolicy => {
  const maximumArtifactBytes = parsePositiveInteger(
    bindings.MAX_ARTIFACT_BYTES,
    PROTOCOL_MAX_ARTIFACT_BYTES,
  );
  if (maximumArtifactBytes > PROTOCOL_MAX_ARTIFACT_BYTES) {
    throw new Error("MAX_ARTIFACT_BYTES exceeds the protocol maximum");
  }

  const maximumExpirySeconds = parsePositiveInteger(
    bindings.MAX_EXPIRY_SECONDS,
    PROTOCOL_MAX_EXPIRY_SECONDS,
  );
  if (maximumExpirySeconds > PROTOCOL_MAX_EXPIRY_SECONDS) {
    throw new Error("MAX_EXPIRY_SECONDS exceeds the protocol maximum");
  }

  const allowedExpirySeconds = (bindings.ALLOWED_EXPIRY_SECONDS === undefined
    ? [...DEFAULT_EXPIRY_POLICY.allowed_seconds]
    : bindings.ALLOWED_EXPIRY_SECONDS.split(",").map((value) =>
        parsePositiveInteger(value.trim(), 0),
      )
  ).filter((value, index, values) => values.indexOf(value) === index);

  if (
    allowedExpirySeconds.length === 0 ||
    allowedExpirySeconds.some((value) => value > maximumExpirySeconds)
  ) {
    throw new Error("Allowed expiry values must be non-empty and within MAX_EXPIRY_SECONDS");
  }

  return {
    allowedExpirySeconds,
    maximumArtifactBytes,
    maximumExpirySeconds,
    maximumSourceChunkBytes: PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
  };
};

const validateUtf8 = (bytes: Uint8Array, label: string): void => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new TypeError("NUL byte");
  } catch {
    throw new ArtifactError("malformed_upload", `${label} must be valid UTF-8 text`, 400);
  }
};

const refuseSensitiveContent = (bytes: Uint8Array, label: string): void => {
  const finding = findFirstSensitiveContent(new TextDecoder().decode(bytes));
  if (finding !== null) {
    throw new ArtifactError(
      "malformed_upload",
      `${label} may contain sensitive ${finding.label}`,
      400,
    );
  }
};

const validateExtraction = (
  mimeType: SupportedMimeType,
  extraction: ExtractionMetadata,
  derivedText: Uint8Array | undefined,
  policy: ArtifactPolicy,
): void => {
  if (mimeType !== "application/pdf") {
    if (
      extraction.status !== "not_applicable" ||
      derivedText !== undefined
    ) {
      throw new ArtifactError(
        "mime_mismatch",
        "Only PDF artifacts can include an extracted representation",
        400,
      );
    }
    return;
  }

  if (extraction.status === "not_applicable") {
    throw new ArtifactError("malformed_upload", "PDF extraction status is required", 400);
  }
  if (extraction.status === "best_effort") {
    if (
      extraction.extractor.length === 0 ||
      extraction.extractor.length > 100 ||
      extraction.extractor_version.length === 0 ||
      extraction.extractor_version.length > 50 ||
      !Number.isSafeInteger(extraction.page_count) ||
      extraction.page_count < 0
    ) {
      throw new ArtifactError("malformed_upload", "PDF extraction metadata is invalid", 400);
    }
    if (derivedText === undefined || derivedText.byteLength === 0) {
      throw new ArtifactError(
        "malformed_upload",
        "Best-effort PDF extraction requires derived text",
        400,
      );
    }
    if (derivedText.byteLength > policy.maximumArtifactBytes) {
      throw new ArtifactError("artifact_too_large", "Derived text exceeds the upload limit", 413);
    }
    validateUtf8(derivedText, "Derived text");
  } else {
    if (
      (extraction.extractor !== undefined &&
        (extraction.extractor.length === 0 || extraction.extractor.length > 100)) ||
      (extraction.extractor_version !== undefined &&
        (extraction.extractor_version.length === 0 || extraction.extractor_version.length > 50)) ||
      (extraction.reason !== undefined &&
        (extraction.reason.length === 0 || extraction.reason.length > 240))
    ) {
      throw new ArtifactError("malformed_upload", "PDF extraction metadata is invalid", 400);
    }
    if (derivedText !== undefined) {
      throw new ArtifactError(
        "malformed_upload",
        "Unavailable PDF extraction cannot include derived text",
        400,
      );
    }
  }
};

const validatePdfTrust = (input: ArtifactUploadInput, mimeType: SupportedMimeType): void => {
  const pdfTrust = input.pdfTrust ?? (
    mimeType === "application/pdf"
      ? { status: "human_only" as const, reason: "provenance_missing" as const }
      : { status: "not_applicable" as const }
  );
  if (mimeType !== "application/pdf") {
    if (pdfTrust.status !== "not_applicable") {
      throw new ArtifactError("mime_mismatch", "Only PDF artifacts can include PDF trust", 400);
    }
    return;
  }
  if (pdfTrust.status === "not_applicable") {
    throw new ArtifactError("malformed_upload", "PDF trust is required", 400);
  }
  if (pdfTrust.status === "human_only") {
    if (input.extraction.status !== "unavailable" || input.derivedText !== undefined) {
      throw new ArtifactError(
        "malformed_upload",
        "Human-only PDFs cannot include an agent-readable representation",
        400,
      );
    }
    return;
  }
  if (input.extraction.status !== "best_effort" || input.derivedText === undefined) {
    throw new ArtifactError(
      "malformed_upload",
      "Controlled PDFs require their signed canonical source",
      400,
    );
  }
};

export const validateArtifactUpload = (
  input: ArtifactUploadInput,
  policy: ArtifactPolicy,
): SupportedMimeType => {
  if (input.bytes.byteLength === 0) {
    throw new ArtifactError("malformed_upload", "Artifact source cannot be empty", 400);
  }
  if (input.bytes.byteLength > policy.maximumArtifactBytes) {
    throw new ArtifactError("artifact_too_large", "Artifact exceeds the upload limit", 413);
  }
  if (!policy.allowedExpirySeconds.includes(input.expiresInSeconds)) {
    throw new ArtifactError(
      "invalid_expiry",
      `Expiration must be one of: ${policy.allowedExpirySeconds.join(", ")} seconds`,
      400,
    );
  }
  if (input.expiresInSeconds > policy.maximumExpirySeconds) {
    throw new ArtifactError("invalid_expiry", "Expiration exceeds the deployment maximum", 400);
  }
  if (
    input.filename.length === 0 ||
    input.filename.length > 255 ||
    /[\\/\0]/u.test(input.filename)
  ) {
    throw new ArtifactError("malformed_upload", "Filename must not contain a path", 400);
  }

  const mimeType = input.mimeType.toLowerCase() as SupportedMimeType;
  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
    throw new ArtifactError("unsupported_media_type", "Artifact media type is not supported", 415);
  }
  const extension = input.filename.toLowerCase().split(".").pop() ?? "";
  if (!extensionByMime[mimeType].has(extension)) {
    throw new ArtifactError("mime_mismatch", "Filename extension does not match media type", 400);
  }

  if (mimeType === "application/pdf") {
    if (new TextDecoder().decode(input.bytes.slice(0, 5)) !== "%PDF-") {
      throw new ArtifactError("mime_mismatch", "PDF signature does not match media type", 400);
    }
  } else {
    validateUtf8(input.bytes, "Artifact source");
  }

  refuseSensitiveContent(input.bytes, "Artifact source");
  if (input.derivedText !== undefined) {
    refuseSensitiveContent(input.derivedText, "Derived text");
  }

  validateExtraction(mimeType, input.extraction, input.derivedText, policy);
  validatePdfTrust(input, mimeType);
  return mimeType;
};
