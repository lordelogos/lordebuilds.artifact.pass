import { PROTOCOL_VERSION, type ExtractionMetadata } from "artifact-protocol";
import { Hono, type Context } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import {
  requireUploader,
  type ArtifactHonoEnvironment,
  type AuthorizationOptions,
} from "../middleware/authorize";
import { ArtifactApplicationService } from "../storage/artifact-service";
import { sha256 } from "../storage/crypto";
import { ArtifactError } from "../storage/artifact-error";

type ServiceFactory = (bindings: ArtifactServiceBindings) => ArtifactApplicationService;

const parseInteger = (value: FormDataEntryValue | null, field: string): number => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ArtifactError("malformed_upload", `${field} must be an integer`, 400);
  }
  return Number(value);
};

const optionalString = (value: FormDataEntryValue | null): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const publicationPublisher = async (
  context: Context<ArtifactHonoEnvironment>,
): Promise<string | undefined> => {
  const principal = context.get("agentPrincipal");
  if (principal !== undefined) return `agent:${await sha256(principal.id)}`;
  const identity = context.get("accessIdentity");
  if (identity !== undefined) return `access:${await sha256(identity.subject)}`;
  const localPublisher = context.req.header("x-artifact-publisher");
  if (localPublisher === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(localPublisher)) {
    throw new ArtifactError("malformed_upload", "Local publisher identity is malformed", 400);
  }
  return `local:${await sha256(localPublisher)}`;
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
  throw new ArtifactError("malformed_upload", "PDF extraction status is required", 400);
};

export const createArtifactsRouter = (
  createService: ServiceFactory,
  authorizationOptions: AuthorizationOptions = {},
) => {
  const router = new Hono<ArtifactHonoEnvironment>();

  router.post("/", requireUploader(authorizationOptions), async (context) => {
    if (context.req.header("cf-access-jwt-assertion") !== undefined) {
      const origin = context.req.header("origin");
      if (origin !== new URL(context.req.url).origin) {
        throw new ArtifactError("not_found", "Route is unavailable", 404);
      }
    }
    const form = await context.req.formData().catch(() => {
      throw new ArtifactError("malformed_upload", "Expected a multipart upload", 400);
    });
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ArtifactError("malformed_upload", "Upload must include one file", 400);
    }
    const derivedEntry = form.get("derived_text");
    const derivedText =
      derivedEntry instanceof File
        ? new Uint8Array(await derivedEntry.arrayBuffer())
        : typeof derivedEntry === "string"
          ? new TextEncoder().encode(derivedEntry)
          : undefined;
    const service = createService(context.env);
    const publicationAttempt = optionalString(form.get("publication_attempt"));
    const shareToken = optionalString(form.get("share_token"));
    const payloadCommitment = optionalString(form.get("payload_commitment"));
    const hasPublicationFields =
      publicationAttempt !== undefined || shareToken !== undefined || payloadCommitment !== undefined;
    const publisherId = hasPublicationFields ? await publicationPublisher(context) : undefined;
    const created = await service.create({
      filename: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      expiresInSeconds: parseInteger(form.get("expires_in_seconds"), "expires_in_seconds"),
      extraction: parseExtraction(form, file.type.toLowerCase() === "application/pdf"),
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
