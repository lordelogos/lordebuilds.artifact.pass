import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const PROTOCOL_MAX_SOURCE_CHUNK_BYTES = 64 * 1024;
export const PROTOCOL_MAX_EXPIRY_SECONDS = 24 * 60 * 60;

export const SUPPORTED_MIME_TYPES = [
  "text/html",
  "text/markdown",
  "application/pdf",
] as const;

export const DEFAULT_EXPIRY_POLICY = {
  maximum_seconds: PROTOCOL_MAX_EXPIRY_SECONDS,
  allowed_seconds: [900, 1800, 3600, 43200, 86400],
} as const;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const supportedMimeTypeSchema = z.enum(SUPPORTED_MIME_TYPES);
export const extractionStatusSchema = z.enum([
  "not_applicable",
  "best_effort",
  "unavailable",
]);

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 digest");
const artifactIdSchema = z.uuid();
const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((filename) => !/[\\/\0]/u.test(filename), "Expected a filename without path separators");

const extractionMetadataSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_applicable"),
    })
    .strict(),
  z
    .object({
      status: z.literal("best_effort"),
      extractor: z.string().min(1).max(100),
      extractor_version: z.string().min(1).max(50),
      page_count: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      extractor: z.string().min(1).max(100).optional(),
      extractor_version: z.string().min(1).max(50).optional(),
      reason: z.string().min(1).max(240).optional(),
    })
    .strict(),
]);

export const artifactManifestSchema = z
  .object({
    protocol_version: protocolVersionSchema,
    artifact_id: artifactIdSchema,
    filename: filenameSchema,
    mime_type: supportedMimeTypeSchema,
    byte_size: z.number().int().nonnegative().max(PROTOCOL_MAX_ARTIFACT_BYTES),
    sha256: sha256Schema,
    created_at: isoDateTimeSchema,
    expires_at: isoDateTimeSchema,
    extraction: extractionMetadataSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.expires_at) <= Date.parse(manifest.created_at)) {
      context.addIssue({
        code: "custom",
        message: "expires_at must be later than created_at",
        path: ["expires_at"],
      });
    }

    const isPdf = manifest.mime_type === "application/pdf";
    if (isPdf === (manifest.extraction.status === "not_applicable")) {
      context.addIssue({
        code: "custom",
        message: isPdf
          ? "PDF artifacts must report an extraction outcome"
          : "Only PDF artifacts can report a PDF extraction outcome",
        path: ["extraction", "status"],
      });
    }
  });

export const expiryPolicySchema = z
  .object({
    maximum_seconds: z.number().int().positive().max(PROTOCOL_MAX_EXPIRY_SECONDS),
    allowed_seconds: z.array(z.number().int().positive()).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const unique = new Set(policy.allowed_seconds);
    if (unique.size !== policy.allowed_seconds.length) {
      context.addIssue({
        code: "custom",
        message: "Expiry presets must be unique",
        path: ["allowed_seconds"],
      });
    }

    for (const [index, seconds] of policy.allowed_seconds.entries()) {
      if (seconds > policy.maximum_seconds) {
        context.addIssue({
          code: "custom",
          message: "Expiry preset exceeds maximum_seconds",
          path: ["allowed_seconds", index],
        });
      }
      if (index > 0 && seconds <= (policy.allowed_seconds[index - 1] ?? 0)) {
        context.addIssue({
          code: "custom",
          message: "Expiry presets must be strictly increasing",
          path: ["allowed_seconds", index],
        });
      }
    }
  });

const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u, "Expected an opaque cursor");
const base64Schema = z.string().refine(
  (value) => value.length === 0 || /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),
  "Expected canonical base64 data",
);

const base64ByteLength = (value: string): number => {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

export const sourceChunkSchema = z
  .object({
    protocol_version: protocolVersionSchema,
    artifact_id: artifactIdSchema,
    encoding: z.literal("base64"),
    byte_offset: z.number().int().nonnegative(),
    byte_length: z.number().int().nonnegative().max(PROTOCOL_MAX_SOURCE_CHUNK_BYTES),
    total_size: z.number().int().nonnegative().max(PROTOCOL_MAX_ARTIFACT_BYTES),
    sha256: sha256Schema,
    data: base64Schema,
    next_cursor: cursorSchema.nullable(),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.byte_offset + chunk.byte_length > chunk.total_size) {
      context.addIssue({
        code: "custom",
        message: "Chunk exceeds the declared source size",
        path: ["byte_length"],
      });
    }
    if (base64ByteLength(chunk.data) !== chunk.byte_length) {
      context.addIssue({
        code: "custom",
        message: "Decoded data length does not match byte_length",
        path: ["data"],
      });
    }
  });

export const uploadResponseSchema = z
  .object({
    protocol_version: protocolVersionSchema,
    manifest: artifactManifestSchema,
    share_url: z.url({ protocol: /^https$/u }),
  })
  .strict();

export const protocolLimitsSchema = z
  .object({
    protocol_version: protocolVersionSchema,
    supported_mime_types: z.tuple([
      z.literal("text/html"),
      z.literal("text/markdown"),
      z.literal("application/pdf"),
    ]),
    max_artifact_bytes: z.number().int().positive().max(PROTOCOL_MAX_ARTIFACT_BYTES),
    max_source_chunk_bytes: z.literal(PROTOCOL_MAX_SOURCE_CHUNK_BYTES),
    expiry: expiryPolicySchema,
  })
  .strict();

export const protocolCompatibilityRequestSchema = z
  .object({
    protocol_version: z.number().int().positive(),
  })
  .strict();

export const artifactErrorCodeSchema = z.enum([
  "unsupported_media_type",
  "mime_mismatch",
  "artifact_too_large",
  "malformed_upload",
  "invalid_expiry",
  "incompatible_protocol_version",
  "unauthorized",
  "forbidden",
  "not_found",
  "expired",
  "invalid_cursor",
  "internal_error",
]);

export const artifactErrorSchema = z
  .object({
    protocol_version: protocolVersionSchema,
    error: z
      .object({
        code: artifactErrorCodeSchema,
        message: z.string().min(1).max(240),
        request_id: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ExpiryPolicy = z.infer<typeof expiryPolicySchema>;
export type ExtractionMetadata = z.infer<typeof extractionMetadataSchema>;
export type SourceChunk = z.infer<typeof sourceChunkSchema>;
export type SupportedMimeType = z.infer<typeof supportedMimeTypeSchema>;
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
