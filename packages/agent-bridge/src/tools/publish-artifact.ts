import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PROTOCOL_MAX_ARTIFACT_BYTES,
  uploadResponseSchemaForOrigin,
  type ExtractionMetadata,
  type PdfTrust,
  type SupportedMimeType,
  type UploadResponse,
} from "artifact-protocol";
import { extractPdfInNode, type PdfExtractionResult } from "representation-pipeline";
import { qualifyAndSignPdfProvenance } from "representation-pipeline/node-provenance";
import { createPayloadCommitment } from "../../../../scripts/publication-commitment.mjs";
import {
  findFirstSensitiveContent,
  findSensitivePath,
} from "../../../../scripts/security-patterns.mjs";

import { assertDeploymentOrigin, fetchWithoutRedirects, responseError } from "../http/safe-fetch";
import {
  MemoryPublicationJournal,
  type PublicationJournal,
} from "../state/publication-journal";
import { parseShareUrl } from "./read-artifact";

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
  readonly canonicalSourcePath?: string;
}

export interface PublishArtifactDependencies {
  readonly baseUrl: URL;
  readonly workspaceRoots: readonly string[];
  readonly token?: string;
  readonly openDevelopment?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly fileOperations?: FileOperations;
  readonly extractPdf?: (bytes: Uint8Array) => Promise<PdfExtractionResult>;
  readonly journal?: PublicationJournal;
  readonly pdfProvenance?: {
    readonly keyId: string;
    readonly privateKeyPkcs8Base64: string;
  };
}

type AuthorizedPublishArtifactDependencies =
  Omit<PublishArtifactDependencies, "openDevelopment" | "token"> & (
    | { readonly openDevelopment: true; readonly token: string | undefined }
    | { readonly openDevelopment: false; readonly token: string }
  );

const authorizePublishDependencies = (
  dependencies: PublishArtifactDependencies,
): AuthorizedPublishArtifactDependencies => {
  const token = dependencies.token?.trim();
  if (dependencies.openDevelopment === true) {
    return { ...dependencies, openDevelopment: true, token };
  }
  if (!token) {
    throw new Error("A non-empty ArtifactPass token is required for production publishing");
  }
  return { ...dependencies, openDevelopment: false, token };
};

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

const validateBytes = (bytes: Uint8Array, mimeType: SupportedMimeType): string | undefined => {
  if (bytes.byteLength === 0) throw new Error("Artifact source cannot be empty");
  if (bytes.byteLength > PROTOCOL_MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the supported size");
  if (mimeType === "application/pdf") {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new Error("PDF signature does not match the filename");
    }
    return undefined;
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0")) throw new Error("NUL byte");
    return source;
  } catch {
    throw new Error("Text artifacts must contain valid UTF-8");
  }
};

const assertSafeContent = (content: string | Uint8Array, label = "Artifact content"): void => {
  const source = typeof content === "string" ? content : new TextDecoder().decode(content);
  const finding = findFirstSensitiveContent(source);
  if (finding !== null) {
    throw new Error(`${label} may contain sensitive ${finding.label}`);
  }
};

interface PreparedExtraction {
  readonly metadata: ExtractionMetadata;
  readonly pdfTrust: PdfTrust;
  readonly derivedBytes?: Uint8Array;
  readonly derivedText?: string;
  readonly safetyCoverage?: PdfExtractionResult["safetyCoverage"];
}

const addExtraction = async (
  form: FormData,
  mimeType: SupportedMimeType,
  bytes: Uint8Array,
  extractPdf: (bytes: Uint8Array) => Promise<PdfExtractionResult>,
  controlled?: {
    readonly canonicalSource: Uint8Array;
    readonly keyId: string;
    readonly privateKeyPkcs8Base64: string;
  },
): Promise<PreparedExtraction> => {
  if (mimeType !== "application/pdf") {
    form.set("extraction_status", "not_applicable");
    return {
      metadata: { status: "not_applicable" },
      pdfTrust: { status: "not_applicable" },
    };
  }
  let result: PdfExtractionResult;
  try {
    result = await extractPdf(bytes);
  } catch {
    if (controlled !== undefined) {
      throw new Error("Controlled PDF verification could not read the rendered document");
    }
    form.set("extraction_status", "unavailable");
    form.set("extraction_reason", "Embedded PDF text extraction was unavailable.");
    return {
      metadata: {
        status: "unavailable",
        reason: "Embedded PDF text extraction was unavailable.",
      },
      pdfTrust: { status: "human_only", reason: "provenance_invalid" },
    };
  }
  const extractedText = result.pages.map((page) => page.text).join("\n");
  if (extractedText.length > 0) assertSafeContent(extractedText, "Extracted PDF text");
  if (controlled === undefined) {
    const metadata = {
      status: "unavailable" as const,
      reason: "No authenticated canonical PDF source was supplied.",
    };
    form.set("extraction_status", metadata.status);
    form.set("extraction_reason", metadata.reason);
    return {
      metadata,
      pdfTrust: { status: "human_only", reason: "provenance_missing" },
    };
  }
  form.set("extraction_status", result.metadata.status);
  if (result.metadata.extractor !== undefined) form.set("extractor", result.metadata.extractor);
  if (result.metadata.extractor_version !== undefined) {
    form.set("extractor_version", result.metadata.extractor_version);
  }
  if (result.metadata.status === "best_effort") {
    form.set("page_count", String(result.metadata.page_count));
    const qualified = await qualifyAndSignPdfProvenance({
      canonicalSource: controlled.canonicalSource,
      pdfBytes: bytes,
      extraction: result,
      keyId: controlled.keyId,
      privateKeyPkcs8Base64: controlled.privateKeyPkcs8Base64,
    });
    const derivedBytes = qualified.canonicalSource;
    const derivedText = new TextDecoder("utf-8", { fatal: true }).decode(derivedBytes);
    form.set("derived_text", new File([Buffer.from(derivedBytes)], `${basename("artifact.pdf")}.txt`, {
      type: "text/plain;charset=utf-8",
    }));
    form.set("pdf_provenance", JSON.stringify(qualified.receipt));
    return {
      metadata: result.metadata,
      pdfTrust: { status: "controlled", receipt: qualified.receipt },
      derivedBytes,
      derivedText,
      safetyCoverage: result.safetyCoverage,
    };
  } else if (result.metadata.reason !== undefined) {
    form.set("extraction_reason", result.metadata.reason);
  }
  throw new Error("Controlled PDF verification could not prove visible-content coverage");
};

export const publishArtifact = async (
  input: PublishArtifactInput,
  dependencies: PublishArtifactDependencies,
): Promise<UploadResponse> => {
  const authorizedDependencies = authorizePublishDependencies(dependencies);
  const operations = authorizedDependencies.fileOperations ?? nodeFileOperations;
  const path = await resolveApprovedPath(input.path, authorizedDependencies.workspaceRoots, operations);
  const filename = basename(path);
  const sensitiveSegment = findSensitivePath(path);
  if (sensitiveSegment !== null) {
    throw new Error(`Artifact path contains a sensitive segment: ${sensitiveSegment}`);
  }
  const mimeType = mimeByExtension[extname(path).toLowerCase()];
  if (mimeType === undefined) throw new Error("Artifact type is not supported");

  const file = await operations.open(path);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("Artifact path must refer to a regular file");
    if (before.size > PROTOCOL_MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the supported size");
    const bytes = new Uint8Array(await file.readFile());
    assertUnchanged(before, await file.stat());
    const sourceText = validateBytes(bytes, mimeType);
    assertSafeContent(sourceText ?? bytes);

    let controlledPdf: {
      readonly canonicalSource: Uint8Array;
      readonly keyId: string;
      readonly privateKeyPkcs8Base64: string;
    } | undefined;
    if (input.canonicalSourcePath !== undefined) {
      if (mimeType !== "application/pdf") {
        throw new Error("Canonical PDF source can only accompany a PDF artifact");
      }
      if (authorizedDependencies.pdfProvenance === undefined) {
        throw new Error("Controlled PDF signing is not configured");
      }
      const canonicalPath = await resolveApprovedPath(
        input.canonicalSourcePath,
        authorizedDependencies.workspaceRoots,
        operations,
      );
      if (findSensitivePath(canonicalPath) !== null) {
        throw new Error("Canonical PDF source path contains a sensitive segment");
      }
      const canonicalFile = await operations.open(canonicalPath);
      try {
        const canonicalBefore = await canonicalFile.stat();
        if (!canonicalBefore.isFile()) throw new Error("Canonical PDF source must be a regular file");
        const canonicalSource = new Uint8Array(await canonicalFile.readFile());
        assertUnchanged(canonicalBefore, await canonicalFile.stat());
        const canonicalText = new TextDecoder("utf-8", { fatal: true }).decode(canonicalSource);
        assertSafeContent(canonicalText, "Canonical PDF source");
        controlledPdf = { canonicalSource, ...authorizedDependencies.pdfProvenance };
      } finally {
        await canonicalFile.close();
      }
    }

    const form = new FormData();
    form.set("file", new File([bytes], filename, { type: mimeType }));
    form.set("expires_in_seconds", String(input.expiresInSeconds));
    const extraction = await addExtraction(
      form,
      mimeType,
      bytes,
      authorizedDependencies.extractPdf ?? (async (pdfBytes) => extractPdfInNode({ bytes: pdfBytes })),
      controlledPdf,
    );
    if (extraction.derivedBytes !== undefined) {
      assertSafeContent(extraction.derivedText ?? extraction.derivedBytes, "Derived PDF text");
    }
    assertUnchanged(before, await file.stat());

    const payloadCommitment = await createPayloadCommitment({
      bytes,
      ...(extraction.derivedBytes === undefined ? {} : { derivedBytes: extraction.derivedBytes }),
      expiresInSeconds: input.expiresInSeconds,
      extraction: extraction.metadata,
      pdfTrust: extraction.pdfTrust,
      filename,
      mimeType,
    });
    const journal = authorizedDependencies.journal ?? new MemoryPublicationJournal();
    const publication = await journal.prepare(
      payloadCommitment,
      Date.now() + input.expiresInSeconds * 1000,
    );
    form.set("publication_attempt", publication.attemptId);
    form.set("share_token", publication.shareToken);
    form.set("payload_commitment", payloadCommitment);

    const baseUrl = assertDeploymentOrigin(authorizedDependencies.baseUrl, {
      openDevelopment: authorizedDependencies.openDevelopment,
    });
    const headers = new Headers();
    headers.set("x-artifact-publisher", publication.publisherId);
    if (authorizedDependencies.token !== undefined) {
      headers.set("authorization", `Bearer ${authorizedDependencies.token}`);
    }
    const response = await fetchWithoutRedirects(
      authorizedDependencies.fetch ?? globalThis.fetch,
      new URL("/api/artifacts", baseUrl),
      {
        method: "POST",
        headers,
        body: form,
      },
    );
    if (!response.ok) throw await responseError(response);
    const result = uploadResponseSchemaForOrigin(baseUrl).parse(await response.json());
    try {
      parseShareUrl(result.share_url, baseUrl);
    } catch {
      throw new Error("ArtifactPass returned a foreign share origin");
    }
    await journal.acknowledge(
      payloadCommitment,
      publication.attemptId,
      Date.parse(result.manifest.expires_at),
    );
    return result;
  } finally {
    await file.close();
  }
};
