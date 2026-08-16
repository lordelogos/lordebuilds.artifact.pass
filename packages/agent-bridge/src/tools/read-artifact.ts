import {
  PROTOCOL_MAX_ARTIFACT_BYTES,
  PROTOCOL_MAX_SOURCE_CHUNK_BYTES,
  artifactManifestSchema,
  sourceChunkSchema,
  type ArtifactManifest,
} from "artifact-protocol";

import { assertDeploymentOrigin, fetchWithoutRedirects, responseError } from "../http/safe-fetch";

export interface ReadArtifactInput {
  readonly shareUrl: string;
  readonly cursor?: string;
  readonly maxBytes?: number;
  readonly representation?: "auto" | "source" | "derived";
}

export interface ReadArtifactDependencies {
  readonly baseUrl: URL;
  readonly openDevelopment?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ReadArtifactResult {
  readonly manifest: ArtifactManifest;
  readonly representation: "source" | "derived" | "pdf_metadata";
  readonly encoding: "base64";
  readonly byte_offset: number;
  readonly byte_length: number;
  readonly total_size: number;
  readonly sha256: string;
  readonly data: string;
  readonly text?: string;
  readonly next_cursor: string | null;
  readonly exact_source_url?: string;
}

const sharePathPattern = /^\/a\/([A-Za-z0-9_-]{32,256})$/u;
const cursorPattern = /^[A-Za-z0-9_-]{16,256}$/u;

const parseShareUrl = (value: string, baseUrl: URL): { readonly url: URL; readonly token: string } => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Artifact Share URL is malformed");
  }
  if (
    url.origin !== baseUrl.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Artifact Share URL must use the configured deployment origin");
  }
  const match = sharePathPattern.exec(url.pathname);
  if (match?.[1] === undefined) throw new Error("Artifact Share URL path is malformed");
  return { url, token: match[1] };
};

const responseJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw await responseError(response);
  return response.json().catch(() => {
    throw new Error("Artifact Share returned malformed JSON");
  });
};

const decodeDerivedCursor = (cursor: string | undefined, artifactId: string): number => {
  if (cursor === undefined) return 0;
  if (!cursorPattern.test(cursor)) throw new Error("Artifact source cursor is invalid");
  try {
    const value = Buffer.from(cursor, "base64url").toString("utf8");
    const prefix = `${artifactId}:derived:`;
    if (!value.startsWith(prefix)) throw new Error("Wrong artifact");
    const offset = value.slice(prefix.length);
    if (!/^(?:0|[1-9]\d*)$/u.test(offset)) throw new Error("Invalid offset");
    return Number(offset);
  } catch {
    throw new Error("Artifact source cursor is invalid");
  }
};

const readDerived = async (
  manifest: ArtifactManifest,
  shareBase: URL,
  input: ReadArtifactInput,
  fetchImplementation: typeof globalThis.fetch,
  maximumBytes: number,
): Promise<ReadArtifactResult> => {
  if (manifest.mime_type !== "application/pdf" || manifest.extraction.status !== "best_effort") {
    throw new Error("Artifact does not have an extracted PDF representation");
  }
  const offset = decodeDerivedCursor(input.cursor, manifest.artifact_id);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > PROTOCOL_MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact source cursor is invalid");
  }
  const response = await fetchWithoutRedirects(
    fetchImplementation,
    new URL(`${shareBase.pathname}/derived`, shareBase),
    { headers: { Range: `bytes=${offset}-${offset + maximumBytes - 1}` } },
  );
  if (!response.ok) throw await responseError(response);
  if (response.status !== 206) throw new Error("Artifact Share ignored the derived text range");
  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
  const sha256 = response.headers.get("x-artifact-sha256") ?? "";
  if (contentRange === null || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Artifact Share returned malformed derived text metadata");
  }
  const responseOffset = Number(contentRange[1]);
  const responseEnd = Number(contentRange[2]);
  const totalSize = Number(contentRange[3]);
  if (
    responseOffset !== offset ||
    !Number.isSafeInteger(responseEnd) ||
    responseEnd < responseOffset ||
    !Number.isSafeInteger(totalSize) ||
    totalSize <= 0 ||
    totalSize > PROTOCOL_MAX_ARTIFACT_BYTES
  ) {
    throw new Error("Artifact Share returned inconsistent derived text metadata");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== responseEnd - responseOffset + 1 || bytes.byteLength > maximumBytes) {
    throw new Error("Artifact Share returned an invalid derived text range");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Artifact Share returned malformed derived text");
  }
  if (offset > totalSize) {
    throw new Error("Artifact source cursor is invalid");
  }
  const nextOffset = offset + bytes.byteLength;
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = undefined;
  }
  return {
    manifest,
    representation: "derived",
    encoding: "base64",
    byte_offset: offset,
    byte_length: bytes.byteLength,
    total_size: totalSize,
    sha256,
    data: Buffer.from(bytes).toString("base64"),
    ...(text === undefined ? {} : { text }),
    next_cursor: nextOffset < totalSize
      ? Buffer.from(`${manifest.artifact_id}:derived:${nextOffset}`).toString("base64url")
      : null,
    exact_source_url: new URL(`${shareBase.pathname}/raw`, shareBase).toString(),
  };
};

export const readArtifact = async (
  input: ReadArtifactInput,
  dependencies: ReadArtifactDependencies,
): Promise<ReadArtifactResult> => {
  const baseUrl = assertDeploymentOrigin(dependencies.baseUrl, {
    openDevelopment: dependencies.openDevelopment === true,
  });
  const share = parseShareUrl(input.shareUrl, baseUrl);
  if (input.cursor !== undefined && !cursorPattern.test(input.cursor)) {
    throw new Error("Artifact source cursor is invalid");
  }
  const maximumBytes = input.maxBytes ?? PROTOCOL_MAX_SOURCE_CHUNK_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > PROTOCOL_MAX_SOURCE_CHUNK_BYTES) {
    throw new Error("Artifact source chunk size is invalid");
  }
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const manifestResponse = await fetchWithoutRedirects(
    fetchImplementation,
    new URL(`${share.url.pathname}/manifest`, baseUrl),
  );
  const manifest = artifactManifestSchema.parse(await responseJson(manifestResponse));
  const representation = input.representation ?? "auto";

  if (representation === "derived" || (representation === "auto" && manifest.extraction.status === "best_effort")) {
    return readDerived(manifest, share.url, input, fetchImplementation, maximumBytes);
  }
  if (representation === "auto" && manifest.mime_type === "application/pdf") {
    return {
      manifest,
      representation: "pdf_metadata",
      encoding: "base64",
      byte_offset: 0,
      byte_length: 0,
      total_size: manifest.byte_size,
      sha256: manifest.sha256,
      data: "",
      next_cursor: null,
      exact_source_url: new URL(`${share.url.pathname}/raw`, baseUrl).toString(),
    };
  }

  const sourceUrl = new URL(`${share.url.pathname}/source`, baseUrl);
  sourceUrl.searchParams.set("limit", String(maximumBytes));
  if (input.cursor !== undefined) sourceUrl.searchParams.set("cursor", input.cursor);
  const sourceResponse = await fetchWithoutRedirects(fetchImplementation, sourceUrl);
  const chunk = sourceChunkSchema.parse(await responseJson(sourceResponse));
  if (
    chunk.artifact_id !== manifest.artifact_id ||
    chunk.total_size !== manifest.byte_size ||
    chunk.sha256 !== manifest.sha256
  ) {
    throw new Error("Artifact Share returned inconsistent source metadata");
  }
  const bytes = Buffer.from(chunk.data, "base64");
  let text: string | undefined;
  if (manifest.mime_type !== "application/pdf") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = undefined;
    }
  }
  return {
    manifest,
    representation: "source",
    encoding: "base64",
    byte_offset: chunk.byte_offset,
    byte_length: chunk.byte_length,
    total_size: chunk.total_size,
    sha256: chunk.sha256,
    data: chunk.data,
    ...(text === undefined ? {} : { text }),
    next_cursor: chunk.next_cursor,
    ...(manifest.mime_type === "application/pdf"
      ? { exact_source_url: new URL(`${share.url.pathname}/raw`, baseUrl).toString() }
      : {}),
  };
};
