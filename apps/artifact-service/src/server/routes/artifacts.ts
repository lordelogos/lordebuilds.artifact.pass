import {
  PROTOCOL_VERSION,
  pdfProvenanceReceiptSchema,
  type ExtractionMetadata,
  type PdfTrust,
} from "artifact-protocol";
import { Hono, type Context } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import {
  requireUploader,
  type ArtifactHonoEnvironment,
  type AuthorizationOptions,
} from "../middleware/authorize";
import { consumeRateLimit } from "../auth/rate-limit";
import { ArtifactApplicationService } from "../storage/artifact-service";
import { sha256 } from "../storage/crypto";
import { ArtifactError } from "../storage/artifact-error";

type ServiceFactory = (bindings: ArtifactServiceBindings) => ArtifactApplicationService;

const PUBLIC_UPLOAD_WINDOW_MILLISECONDS = 10 * 60 * 1_000;
const PUBLIC_UPLOAD_MAXIMUM_REQUESTS = 10;
const PUBLIC_UPLOAD_MAXIMUM_BYTES = 64 * 1024 * 1024;
const UPLOAD_FIELDS = new Set([
  "derived_text",
  "expires_in_seconds",
  "extraction_reason",
  "extraction_status",
  "extractor",
  "extractor_version",
  "file",
  "page_count",
  "payload_commitment",
  "pdf_provenance",
  "publication_attempt",
  "share_token",
]);

export interface PublicUploadOptions {
  readonly now?: () => number;
  readonly disabled?: boolean;
  readonly windowMilliseconds?: number;
  readonly maximumRequests?: number;
  readonly maximumBytes?: number;
}

interface PublicUploadQuota {
  readonly units: number;
  readonly maximumUnits: number;
  readonly actorNamespace: string;
  readonly networkNamespace: string;
  readonly errorMessage: string;
}

const createPublicUploadBudget = (
  context: Context<ArtifactHonoEnvironment>,
  options: PublicUploadOptions,
) => {
  if (context.env.HUMAN_AUTH_MODE !== "artifactpass" || options.disabled === true) return null;
  const principal = context.get("agentPrincipal");
  const identity = context.get("humanIdentity");
  if (principal === undefined && identity === undefined) return null;
  const actor = `identity:${principal?.subject ?? identity?.subject ?? "unknown"}`;
  const network = context.req.header("cf-connecting-ip") ?? "unknown";
  const common = {
    database: context.env.ARTIFACT_DB,
    timestamp: (options.now ?? Date.now)(),
    windowMilliseconds: options.windowMilliseconds ?? PUBLIC_UPLOAD_WINDOW_MILLISECONDS,
  };
  return async (quota: PublicUploadQuota): Promise<void> => {
    await consumeRateLimit({
      ...common,
      namespace: quota.actorNamespace,
      source: actor,
      units: quota.units,
      maximumUnits: quota.maximumUnits,
      errorMessage: quota.errorMessage,
    });
    await consumeRateLimit({
      ...common,
      namespace: quota.networkNamespace,
      source: network,
      units: quota.units,
      maximumUnits: quota.maximumUnits,
      errorMessage: quota.errorMessage,
    });
  };
};

const parseInteger = (value: FormDataEntryValue | null, field: string): number => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ArtifactError("malformed_upload", `${field} must be an integer`, 400);
  }
  return Number(value);
};

const optionalString = (value: FormDataEntryValue | null): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

interface PublicationPublishers {
  readonly current: string;
  readonly legacy?: string;
}

const publicationPublishers = async (
  context: Context<ArtifactHonoEnvironment>,
): Promise<PublicationPublishers | undefined> => {
  const principal = context.get("agentPrincipal");
  if (principal !== undefined) {
    return {
      current: `agent:${await sha256(principal.subject)}`,
      legacy: `agent:${await sha256(principal.id)}`,
    };
  }
  const identity = context.get("accessIdentity");
  if (identity !== undefined) return { current: `access:${await sha256(identity.subject)}` };
  const localPublisher = context.req.header("x-artifact-publisher");
  if (localPublisher === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(localPublisher)) {
    throw new ArtifactError("malformed_upload", "Local publisher identity is malformed", 400);
  }
  return { current: `local:${await sha256(localPublisher)}` };
};

const parseExtraction = (form: FormData, isPdf: boolean): ExtractionMetadata => {
  const status = form.get("extraction_status");
  if (!isPdf) return { status: "not_applicable" };
  if (status === "best_effort") {
    return {
      status,
      extractor: optionalString(form.get("extractor")) ?? "unknown",
      extractor_version: optionalString(form.get("extractor_version")) ?? "unknown",
      page_count: parseInteger(form.get("page_count"), "page_count"),
    };
  }
  if (status === "unavailable") {
    return {
      status,
      ...(optionalString(form.get("extractor")) === undefined
        ? {}
        : { extractor: optionalString(form.get("extractor")) }),
      ...(optionalString(form.get("extractor_version")) === undefined
        ? {}
        : { extractor_version: optionalString(form.get("extractor_version")) }),
      ...(optionalString(form.get("extraction_reason")) === undefined
        ? {}
        : { reason: optionalString(form.get("extraction_reason")) }),
    };
  }
  if (status === null) {
    return {
      status: "unavailable",
      reason: "No agent-readable PDF source was supplied.",
    };
  }
  throw new ArtifactError("malformed_upload", "PDF extraction status is required", 400);
};

const parsePdfTrust = (form: FormData, isPdf: boolean): PdfTrust => {
  if (!isPdf) return { status: "not_applicable" };
  const receiptValue = optionalString(form.get("pdf_provenance"));
  if (receiptValue === undefined) return { status: "human_only", reason: "provenance_missing" };
  try {
    return { status: "controlled", receipt: pdfProvenanceReceiptSchema.parse(JSON.parse(receiptValue)) };
  } catch {
    throw new ArtifactError("malformed_upload", "PDF provenance receipt is malformed", 400);
  }
};

export const createArtifactsRouter = (
  createService: ServiceFactory,
  authorizationOptions: AuthorizationOptions = {},
  publicUploadOptions: PublicUploadOptions = {},
) => {
  const router = new Hono<ArtifactHonoEnvironment>();

  router.post("/", requireUploader(authorizationOptions), async (context) => {
    if (context.get("humanIdentity") !== undefined) {
      const origin = context.req.header("origin");
      if (origin !== new URL(context.req.url).origin) {
        throw new ArtifactError("not_found", "Route is unavailable", 404);
      }
    }
    const consumePublicUpload = createPublicUploadBudget(context, publicUploadOptions);
    await consumePublicUpload?.({
      units: 1,
      maximumUnits: publicUploadOptions.maximumRequests ?? PUBLIC_UPLOAD_MAXIMUM_REQUESTS,
      actorNamespace: "public-upload-attempt-actor",
      networkNamespace: "public-upload-attempt-network",
      errorMessage: "Public upload attempt limit exceeded; try again later",
    });
    const form = await context.req.formData().catch(() => {
      throw new ArtifactError("malformed_upload", "Expected a multipart upload", 400);
    });
    const file = form.get("file");
    const derivedEntry = form.get("derived_text");
    const encodedDerivedText = typeof derivedEntry === "string"
      ? new TextEncoder().encode(derivedEntry)
      : undefined;
    const seenFields = new Set<string>();
    let uploadByteLength = 0;
    let invalidField: string | undefined;
    for (const [field, entry] of form.entries()) {
      if (!UPLOAD_FIELDS.has(field) || seenFields.has(field)) invalidField ??= field;
      seenFields.add(field);
      uploadByteLength += entry instanceof File
        ? entry.size
        : field === "derived_text" && encodedDerivedText !== undefined
          ? encodedDerivedText.byteLength
          : new TextEncoder().encode(entry).byteLength;
    }
    if (invalidField !== undefined) {
      throw new ArtifactError("malformed_upload", `Upload field is unknown or duplicated: ${invalidField}`, 400);
    }
    if (!(file instanceof File)) {
      throw new ArtifactError("malformed_upload", "Upload must include one file", 400);
    }
    const derivedText =
      derivedEntry instanceof File
        ? new Uint8Array(await derivedEntry.arrayBuffer())
        : encodedDerivedText;
    const publicationAttempt = optionalString(form.get("publication_attempt"));
    const shareToken = optionalString(form.get("share_token"));
    const payloadCommitment = optionalString(form.get("payload_commitment"));
    const hasPublicationFields =
      publicationAttempt !== undefined || shareToken !== undefined || payloadCommitment !== undefined;
    const publishers = hasPublicationFields ? await publicationPublishers(context) : undefined;
    const service = createService(context.env);
    let retryPublisherId: string | undefined;
    if (
      publishers !== undefined &&
      publicationAttempt !== undefined &&
      shareToken !== undefined &&
      payloadCommitment !== undefined
    ) {
      if (await service.publicationExists(publishers.current, publicationAttempt)) {
        retryPublisherId = publishers.current;
      } else if (
        publishers.legacy !== undefined &&
        await service.publicationExists(publishers.legacy, publicationAttempt)
      ) {
        retryPublisherId = publishers.legacy;
      }
    }
    const isPublicationRetry = retryPublisherId !== undefined;
    const publisherId = retryPublisherId ?? publishers?.current;
    if (!isPublicationRetry) {
      await consumePublicUpload?.({
        units: uploadByteLength,
        maximumUnits: publicUploadOptions.maximumBytes ?? PUBLIC_UPLOAD_MAXIMUM_BYTES,
        actorNamespace: "public-upload-bytes-actor",
        networkNamespace: "public-upload-bytes-network",
        errorMessage: "Public upload byte limit exceeded; try again later",
      });
    }
    const created = await service.create({
      filename: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      expiresInSeconds: parseInteger(form.get("expires_in_seconds"), "expires_in_seconds"),
      extraction: parseExtraction(form, file.type.toLowerCase() === "application/pdf"),
      pdfTrust: parsePdfTrust(form, file.type.toLowerCase() === "application/pdf"),
      ...(derivedText === undefined ? {} : { derivedText }),
      ...(publisherId === undefined ? {} : { publisherId }),
      ...(publicationAttempt === undefined ? {} : { publicationAttempt }),
      ...(shareToken === undefined ? {} : { shareToken }),
      ...(payloadCommitment === undefined ? {} : { payloadCommitment }),
    });
    const shareUrl = new URL(`/a/${created.shareToken}`, context.req.url).toString();

    return context.json(
      {
        protocol_version: PROTOCOL_VERSION,
        manifest: created.manifest,
        share_url: shareUrl,
      },
      created.created ? 201 : 200,
    );
  });

  return router;
};
