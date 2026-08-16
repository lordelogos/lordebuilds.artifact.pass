import {
  PROTOCOL_VERSION,
  sourceChunkSchema,
} from "artifact-protocol";
import { Hono } from "hono";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";
import {
  ArtifactApplicationService,
  artifactRecordToManifest,
} from "../storage/artifact-service";
import { ArtifactError } from "../storage/artifact-error";
import type { ArtifactRecord, ArtifactPolicy } from "../storage/artifact-types";

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

const viewer = (artifact: ArtifactRecord, shareToken: string): string => {
  const filename = artifact.filename
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${filename}</title></head><body><main><h1>${filename}</h1><p>${artifact.mimeType}</p><a href="/a/${shareToken}/raw">Open exact source</a></main></body></html>`;
};

export const createSharesRouter = (
  createService: ServiceFactory,
  createPolicy: PolicyFactory,
) => {
  const router = new Hono<{ Bindings: ArtifactServiceBindings }>();

  router.get("/:shareToken", async (context) => {
    const artifact = await createService(context.env).resolve(context.req.param("shareToken"));
    return context.html(viewer(artifact, context.req.param("shareToken")), 200, {
      ...PUBLIC_RESPONSE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
    });
  });

  router.get("/:shareToken/manifest", async (context) => {
    const artifact = await createService(context.env).resolve(context.req.param("shareToken"));
    return context.json(artifactRecordToManifest(artifact), 200, PUBLIC_RESPONSE_HEADERS);
  });

  router.get("/:shareToken/source", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.req.param("shareToken"));
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
    const artifact = await service.resolve(context.req.param("shareToken"));
    const object = await service.getDerived(artifact);
    return new Response(object.body, {
      headers: {
        ...PUBLIC_RESPONSE_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": disposition(`${artifact.filename}.txt`),
      },
    });
  });

  router.get("/:shareToken/raw", async (context) => {
    const service = createService(context.env);
    const artifact = await service.resolve(context.req.param("shareToken"));
    const rangeHeader = context.req.header("range");
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
          ...PUBLIC_RESPONSE_HEADERS,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${range.offset}-${range.end}/${artifact.byteSize}`,
          "Content-Length": String(range.length),
          "Content-Type": artifact.mimeType,
          "Content-Disposition": disposition(artifact.filename),
        },
      });
    }

    const object = await service.getSource(artifact);
    return new Response(object.body, {
      headers: {
        ...PUBLIC_RESPONSE_HEADERS,
        ...(artifact.mimeType === "application/pdf" ? { "Accept-Ranges": "bytes" } : {}),
        "Content-Length": String(artifact.byteSize),
        "Content-Type":
          artifact.mimeType === "application/pdf"
            ? artifact.mimeType
            : "text/plain; charset=utf-8",
        "Content-Disposition": disposition(artifact.filename),
      },
    });
  });

  return router;
};

