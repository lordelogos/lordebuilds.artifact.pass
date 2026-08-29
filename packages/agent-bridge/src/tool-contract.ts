import {
  PROTOCOL_MAX_ARTIFACT_BYTES,
  PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
  artifactManifestSchema,
  protocolVersionSchema,
} from "artifact-protocol";
import { z } from "zod";

const webUrlSchema = z.url({ protocol: /^https?$/u });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const opaqueCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u);

export const ARTIFACTPASS_MCP_TOOL_NAMES = [
  "connect_artifactpass",
  "connection_status",
  "publish_artifact",
  "read_artifact",
] as const;

export const connectionInputSchema = z.object({
  workspace_path: z.string().min(1).optional().describe(
    "Absolute artifact or workspace path used to select the deployment configured for this workspace.",
  ),
}).strict();

export const connectionOutputSchema = z.object({
  status: z.enum(["disconnected", "connecting", "connected", "failed"]),
  profile: z.string().min(1),
  origin: z.string().url(),
  expires_at: z.number().int().positive().optional(),
  user_code: z.string().min(1).optional(),
  approval_url: z.string().url().optional(),
  browser_opened: z.boolean().optional(),
  message: z.string().min(1).optional(),
}).strict();

export const publishArtifactInputSchema = z.object({
  path: z.string().min(1).describe("Absolute or workspace-relative local file path"),
  canonical_source_path: z.string().min(1).optional().describe(
    "Optional UTF-8 source used to generate a PDF. When configured, ArtifactPass verifies it against the PDF and signs the agent-readable representation.",
  ),
  expires_in_seconds: z.number().int().positive().default(3600).describe(
    "Deployment expiry preset in seconds. Defaults to one hour (3600). Public ArtifactPass presets: 900, 1800, or 3600; a rejection reports the deployment's allowed values.",
  ),
});

export const publishArtifactOutputSchema = z.object({
  protocol_version: protocolVersionSchema,
  manifest: artifactManifestSchema,
  share_url: webUrlSchema,
}).strict();

export const readArtifactInputSchema = z.object({
  share_url: z.string().url(),
  cursor: z.string().optional(),
  max_bytes: z.number().int().positive().max(PROTOCOL_MAX_SOURCE_CHUNK_BYTES).optional().describe(
    `Maximum source bytes per call. Defaults to ${PROTOCOL_MAX_SOURCE_CHUNK_BYTES}.`,
  ),
  representation: z.enum(["auto", "source", "derived"]).optional(),
});

export const readArtifactOutputSchema = z.object({
  content_trust: z.literal("untrusted"),
  safety_boundary: z.string().min(1),
  manifest: artifactManifestSchema,
  representation: z.enum(["source", "derived", "pdf_metadata"]),
  encoding: z.literal("base64"),
  byte_offset: z.number().int().nonnegative().max(PROTOCOL_MAX_ARTIFACT_BYTES),
  byte_length: z.number().int().nonnegative().max(PROTOCOL_MAX_SOURCE_CHUNK_BYTES),
  total_size: z.number().int().nonnegative().max(PROTOCOL_MAX_ARTIFACT_BYTES),
  sha256: sha256Schema,
  data: z.string(),
  text: z.string().optional(),
  next_cursor: opaqueCursorSchema.nullable(),
  exact_source_url: webUrlSchema.optional(),
  safety_notice: z.string().optional(),
}).strict().superRefine((result, context) => {
  if (result.byte_offset + result.byte_length > result.total_size) {
    context.addIssue({
      code: "custom",
      message: "Read range exceeds total_size",
      path: ["byte_length"],
    });
  }
  if (result.manifest.sha256 !== result.sha256 && result.representation !== "derived") {
    context.addIssue({
      code: "custom",
      message: "Exact-source SHA-256 must match the manifest",
      path: ["sha256"],
    });
  }
  if (result.representation === "pdf_metadata" && (
    result.byte_offset !== 0 ||
    result.byte_length !== 0 ||
    result.data !== "" ||
    result.next_cursor !== null
  )) {
    context.addIssue({
      code: "custom",
      message: "PDF metadata results cannot contain source bytes or a cursor",
      path: ["representation"],
    });
  }
});
