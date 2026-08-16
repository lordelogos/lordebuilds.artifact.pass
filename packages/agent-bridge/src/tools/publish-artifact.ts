import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PROTOCOL_MAX_ARTIFACT_BYTES,
  uploadResponseSchema,
  type SupportedMimeType,
  type UploadResponse,
} from "artifact-protocol";
import { extractPdfInNode, pdfPagesToText, type PdfExtractionResult } from "representation-pipeline";

import { assertSafeDeploymentOrigin, fetchWithoutRedirects, responseError } from "../http/safe-fetch";

interface FileStat {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
  isFile(): boolean;
}

interface OpenFile {
  readFile(): Promise<Buffer>;
  stat(): Promise<FileStat>;
  close(): Promise<void>;
}

export interface FileOperations {
  realpath(path: string): Promise<string>;
  open(path: string): Promise<OpenFile>;
}

export interface PublishArtifactInput {
  readonly path: string;
  readonly expiresInSeconds: number;
}

export interface PublishArtifactDependencies {
  readonly baseUrl: URL;
  readonly workspaceRoots: readonly string[];
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly fileOperations?: FileOperations;
  readonly extractPdf?: (bytes: Uint8Array) => Promise<PdfExtractionResult>;
}

const nodeFileOperations: FileOperations = {
  realpath,
  open: async (path) => open(path, "r"),
};

const mimeByExtension: Readonly<Record<string, SupportedMimeType>> = {
  ".htm": "text/html",
  ".html": "text/html",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
};

const assertUnchanged = (before: FileStat, after: FileStat): void => {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("Artifact file changed while it was being prepared or uploaded");
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const resolveApprovedPath = async (
  candidate: string,
  roots: readonly string[],
  operations: FileOperations,
): Promise<string> => {
  if (roots.length === 0) throw new Error("At least one approved workspace root is required");
  const resolvedCandidate = await operations.realpath(resolve(candidate));
  const resolvedRoots = await Promise.all(roots.map(async (root) => operations.realpath(resolve(root))));
  if (!resolvedRoots.some((root) => isWithin(root, resolvedCandidate))) {
    throw new Error("Artifact path is outside the approved workspace roots");
  }
  return resolvedCandidate;
};

const validateBytes = (bytes: Uint8Array, mimeType: SupportedMimeType): void => {
  if (bytes.byteLength === 0) throw new Error("Artifact source cannot be empty");
  if (bytes.byteLength > PROTOCOL_MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the supported size");
  if (mimeType === "application/pdf") {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new Error("PDF signature does not match the filename");
    }
    return;
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0")) throw new Error("NUL byte");
  } catch {
    throw new Error("Text artifacts must contain valid UTF-8");
  }
};

const addExtraction = async (
  form: FormData,
  mimeType: SupportedMimeType,
  bytes: Uint8Array,
  extractPdf: (bytes: Uint8Array) => Promise<PdfExtractionResult>,
): Promise<void> => {
  if (mimeType !== "application/pdf") {
    form.set("extraction_status", "not_applicable");
    return;
  }
  let result: PdfExtractionResult;
  try {
    result = await extractPdf(bytes);
  } catch {
    form.set("extraction_status", "unavailable");
    form.set("extraction_reason", "Embedded PDF text extraction was unavailable.");
    return;
  }
  form.set("extraction_status", result.metadata.status);
  if (result.metadata.extractor !== undefined) form.set("extractor", result.metadata.extractor);
  if (result.metadata.extractor_version !== undefined) {
    form.set("extractor_version", result.metadata.extractor_version);
  }
  if (result.metadata.status === "best_effort") {
    form.set("page_count", String(result.metadata.page_count));
    const warning = result.qualityWarnings?.includes("layout_may_be_degraded") === true
      ? "[Extraction quality note: column or table layout may be degraded.]\n\n"
      : "";
    const derivedText = `${warning}${pdfPagesToText(result.pages)}`;
    form.set("derived_text", new File([derivedText], `${basename("artifact.pdf")}.txt`, {
      type: "text/plain;charset=utf-8",
    }));
  } else if (result.metadata.reason !== undefined) {
    form.set("extraction_reason", result.metadata.reason);
  }
};

export const publishArtifact = async (
  input: PublishArtifactInput,
  dependencies: PublishArtifactDependencies,
): Promise<UploadResponse> => {
  const operations = dependencies.fileOperations ?? nodeFileOperations;
  const path = await resolveApprovedPath(input.path, dependencies.workspaceRoots, operations);
  const mimeType = mimeByExtension[extname(path).toLowerCase()];
  if (mimeType === undefined) throw new Error("Artifact type is not supported");

  const file = await operations.open(path);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("Artifact path must refer to a regular file");
    if (before.size > PROTOCOL_MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the supported size");
    const bytes = new Uint8Array(await file.readFile());
    assertUnchanged(before, await file.stat());
    validateBytes(bytes, mimeType);

    const form = new FormData();
    form.set("file", new File([bytes], basename(path), { type: mimeType }));
    form.set("expires_in_seconds", String(input.expiresInSeconds));
    await addExtraction(
      form,
      mimeType,
      bytes,
      dependencies.extractPdf ?? (async (pdfBytes) => extractPdfInNode({ bytes: pdfBytes })),
    );
    assertUnchanged(before, await file.stat());

    const baseUrl = assertSafeDeploymentOrigin(dependencies.baseUrl);
    const response = await fetchWithoutRedirects(
      dependencies.fetch ?? globalThis.fetch,
      new URL("/api/artifacts", baseUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${dependencies.token}` },
        body: form,
      },
    );
    if (!response.ok) throw await responseError(response);
    const result = uploadResponseSchema.parse(await response.json());
    const shareUrl = new URL(result.share_url);
    if (
      shareUrl.origin !== baseUrl.origin ||
      shareUrl.username !== "" ||
      shareUrl.password !== "" ||
      shareUrl.search !== "" ||
      shareUrl.hash !== "" ||
      !/^\/a\/[A-Za-z0-9_-]{32,256}$/u.test(shareUrl.pathname)
    ) {
      throw new Error("Artifact Share returned a foreign share origin");
    }
    return result;
  } finally {
    await file.close();
  }
};
