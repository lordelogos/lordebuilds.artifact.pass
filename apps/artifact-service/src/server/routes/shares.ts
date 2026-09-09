import {
  PROTOCOL_VERSION,
  sourceChunkSchema,
} from "artifact-protocol";
import { Hono } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import {
  requirePublicCapability,
  type ArtifactHonoEnvironment,
} from "../middleware/authorize";
import {
  ArtifactApplicationService,
  artifactRecordToManifest,
} from "../storage/artifact-service";
import { ArtifactError } from "../storage/artifact-error";
import type { ArtifactRecord, ArtifactPolicy } from "../storage/artifact-types";
import { renderSharePage, type ShareRepresentation } from "../../web/routes/share-page";
import {
  htmlContainsJavaScript,
  renderSafeHtmlPreview,
  renderSafeMarkdown,
} from "../../web/viewers/content-sanitizer";
import {
  HTML_INTERACTIVE_CONTENT_SECURITY_POLICY,
  HTML_PREVIEW_CONTENT_SECURITY_POLICY,
} from "../../web/viewers/html-preview-policy";

type ServiceFactory = (bindings: ArtifactServiceBindings) => ArtifactApplicationService;
type PolicyFactory = (bindings: ArtifactServiceBindings) => ArtifactPolicy;

export const PUBLIC_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
};

const encodeCursor = (artifactId: string, offset: number): string => {
  const value = `${artifactId}:${offset}`;
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeCursor = (cursor: string, artifactId: string): number => {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(cursor.length / 4) * 4,
      "=",
    );
    const decoded = atob(padded);
    const prefix = `${artifactId}:`;
    if (!decoded.startsWith(prefix)) throw new Error("Wrong artifact");
    const offset = decoded.slice(prefix.length);
    if (!/^(?:0|[1-9]\d*)$/u.test(offset)) throw new Error("Invalid offset");
    return Number(offset);
  } catch {
    throw new ArtifactError("invalid_cursor", "Source cursor is invalid", 400);
  }
};

const parseRange = (
  header: string,
  totalSize: number,
): { readonly offset: number; readonly length: number; readonly end: number } => {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) {
    throw new ArtifactError("malformed_upload", "Range is not satisfiable", 416);
  }
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new ArtifactError("malformed_upload", "Range is not satisfiable", 416);
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? totalSize - 1 : Number(match[2]);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    throw new ArtifactError("malformed_upload", "Range is not satisfiable", 416);
  }
  end = Math.min(end, totalSize - 1);
  return { offset: start, length: end - start + 1, end };
};

const disposition = (filename: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;

const createNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const viewerHeaders = (nonce: string) => ({
  ...PUBLIC_RESPONSE_HEADERS,
  "Content-Security-Policy": [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "frame-src 'self'",
    "connect-src 'none'",
    "img-src 'self' data:",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Content-Type": "text/html; charset=utf-8",
});

const representationFor = async (
  service: ArtifactApplicationService,
  artifact: ArtifactRecord,
  sharePath: string,
): Promise<ShareRepresentation> => {
  if (artifact.mimeType === "application/pdf") {
    return { kind: "pdf", sourceUrl: `${sharePath}/content` };
  }
  const object = await service.getSource(artifact);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await object.arrayBuffer());
  return artifact.mimeType === "text/markdown"
    ? { kind: "markdown", html: renderSafeMarkdown(source), source }
    : {
        kind: "html",
        interactiveUrl: htmlContainsJavaScript(source) ? `${sharePath}/interactive` : undefined,
        previewUrl: `${sharePath}/preview`,
        source,
      };
};

type SourceDisposition = "attachment" | "inline";

const INLINE_SOURCE_HEADERS = {
  ...PUBLIC_RESPONSE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
} as const;

const HTML_PREVIEW_HEADERS = {
  ...PUBLIC_RESPONSE_HEADERS,
  "Content-Security-Policy": HTML_PREVIEW_CONTENT_SECURITY_POLICY,
  "Content-Type": "text/html; charset=utf-8",
} as const;

const HTML_INTERACTIVE_HEADERS = {
  ...PUBLIC_RESPONSE_HEADERS,
  "Content-Security-Policy": HTML_INTERACTIVE_CONTENT_SECURITY_POLICY,
  "Content-Type": "text/html; charset=utf-8",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
} as const;

const sourceHeaders = (responseDisposition: SourceDisposition) =>
  responseDisposition === "inline"
    ? INLINE_SOURCE_HEADERS
    : PUBLIC_RESPONSE_HEADERS;

const sourceResponse = async (
  service: ArtifactApplicationService,
  artifact: ArtifactRecord,
  rangeHeader: string | undefined,
  responseDisposition: SourceDisposition,
): Promise<Response> => {
  if (artifact.mimeType === "application/pdf" && rangeHeader !== undefined) {
    let range: ReturnType<typeof parseRange>;
    try {
      range = parseRange(rangeHeader, artifact.byteSize);
    } catch (error) {
      if (error instanceof ArtifactError && error.status === 416) {
        return new Response(JSON.stringify({
          protocol_version: PROTOCOL_VERSION,
          error: { code: "malformed_upload", message: "Range is not satisfiable" },
        }), {
          status: 416,
          headers: {
            ...PUBLIC_RESPONSE_HEADERS,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Range": `bytes */${artifact.byteSize}`,
          },
        });
      }
      throw error;
    }
    const object = await service.getSource(artifact, range);
    return new Response(object.body, {
      status: 206,
      headers: {
        ...sourceHeaders(responseDisposition),
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${range.offset}-${range.end}/${artifact.byteSize}`,
        "Content-Length": String(range.length),
        "Content-Type": artifact.mimeType,
        "Content-Disposition": `${responseDisposition}; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      },
    });
  }

  const object = await service.getSource(artifact);
  return new Response(object.body, {
    headers: {
      ...sourceHeaders(responseDisposition),
      ...(artifact.mimeType === "application/pdf" ? { "Accept-Ranges": "bytes" } : {}),
      "Content-Length": String(artifact.byteSize),
      "Content-Type": artifact.mimeType === "application/pdf"
        ? artifact.mimeType
        : "text/plain; charset=utf-8",
      "Content-Disposition": `${responseDisposition}; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    },
  });
};

export const createSharesRouter = (
  createService: ServiceFactory,
  createPolicy: PolicyFactory,
) => {
  const router = new Hono<ArtifactHonoEnvironment>();

  router.use("/:shareToken/*", requirePublicCapability());
  router.use("/:shareToken", requirePublicCapability());

  router.get("/:shareToken", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    const sharePath = `/a/${context.get("shareToken")}`;
    const nonce = createNonce();
    return context.html(renderSharePage({
      manifest: artifactRecordToManifest(artifact),
      nonce,
      representation: await representationFor(service, artifact, sharePath),
      sharePath,
    }), 200, viewerHeaders(nonce));
  });

  router.get("/:shareToken/manifest", async (context) => {
    const artifact = await createService(context.env).resolve(context.get("shareToken"));
    return context.json(artifactRecordToManifest(artifact), 200, PUBLIC_RESPONSE_HEADERS);
  });

  router.get("/:shareToken/source", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    const policy = createPolicy(context.env);
    const cursor = context.req.query("cursor");
    const offsetQuery = context.req.query("offset");
    if (cursor !== undefined && offsetQuery !== undefined) {
      throw new ArtifactError("invalid_cursor", "Choose either cursor or offset", 400);
    }
    const offset =
      cursor === undefined
        ? offsetQuery === undefined
          ? 0
          : /^(?:0|[1-9]\d*)$/u.test(offsetQuery)
            ? Number(offsetQuery)
            : Number.NaN
        : decodeCursor(cursor, artifact.id);
    const limitQuery = context.req.query("limit");
    const limit = limitQuery === undefined ? policy.maximumSourceChunkBytes : Number(limitQuery);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > artifact.byteSize ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > policy.maximumSourceChunkBytes
    ) {
      throw new ArtifactError("invalid_cursor", "Source range is invalid", 400);
    }
    const byteLength = Math.min(limit, artifact.byteSize - offset);
    const object = await service.getSource(
      artifact,
      byteLength === 0 ? undefined : { offset, length: byteLength },
    );
    const data = byteLength === 0 ? new Uint8Array() : new Uint8Array(await object.arrayBuffer());
    const nextOffset = offset + data.byteLength;
    const chunk = sourceChunkSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      artifact_id: artifact.id,
      encoding: "base64",
      byte_offset: offset,
      byte_length: data.byteLength,
      total_size: artifact.byteSize,
      sha256: artifact.sha256,
      data: bytesToBase64(data),
      next_cursor: nextOffset < artifact.byteSize ? encodeCursor(artifact.id, nextOffset) : null,
    });
    return context.json(chunk, 200, PUBLIC_RESPONSE_HEADERS);
  });

  router.get("/:shareToken/derived", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    const metadata = await service.getDerived(artifact);
    const sha256 = metadata.metadata?.sha256;
    if (sha256 === undefined || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new ArtifactError("internal_error", "Derived representation metadata is unavailable", 500);
    }
    const rangeHeader = context.req.header("range");
    if (rangeHeader === undefined) {
      return new Response(metadata.body, {
        headers: {
          ...PUBLIC_RESPONSE_HEADERS,
          "Accept-Ranges": "bytes",
          "Content-Length": String(metadata.size),
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": disposition(`${artifact.filename}.txt`),
          "X-Artifact-Sha256": sha256,
        },
      });
    }
    await metadata.body?.cancel().catch(() => undefined);
    const range = parseRange(rangeHeader, metadata.size);
    const object = await service.getDerived(artifact, range);
    return new Response(object.body, {
      status: 206,
      headers: {
        ...PUBLIC_RESPONSE_HEADERS,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${range.offset}-${range.end}/${metadata.size}`,
        "Content-Length": String(range.length),
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": disposition(`${artifact.filename}.txt`),
        "X-Artifact-Sha256": sha256,
      },
    });
  });

  router.get("/:shareToken/raw", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    return sourceResponse(service, artifact, context.req.header("range"), "attachment");
  });

  router.get("/:shareToken/preview", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    if (artifact.mimeType !== "text/html") {
      throw new ArtifactError("not_found", "Artifact is unavailable", 404);
    }
    const object = await service.getSource(artifact);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await object.arrayBuffer());
    const preview = renderSafeHtmlPreview(source);
    return new Response(preview, {
      headers: {
        ...HTML_PREVIEW_HEADERS,
        "Content-Length": String(new TextEncoder().encode(preview).byteLength),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      },
    });
  });

  router.get("/:shareToken/interactive", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    if (artifact.mimeType !== "text/html") {
      throw new ArtifactError("not_found", "Artifact is unavailable", 404);
    }
    const object = await service.getSource(artifact);
    return new Response(object.body, {
      headers: {
        ...HTML_INTERACTIVE_HEADERS,
        "Content-Length": String(artifact.byteSize),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      },
    });
  });

  router.get("/:shareToken/content", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.get("shareToken"));
    if (artifact.mimeType !== "application/pdf") {
      throw new ArtifactError("not_found", "Artifact is unavailable", 404);
    }
    return sourceResponse(service, artifact, context.req.header("range"), "inline");
  });

  return router;
};
