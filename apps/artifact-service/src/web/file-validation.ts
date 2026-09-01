import { findFirstSensitiveContent } from "../../../../scripts/security-patterns.mjs";

const mimeByExtension = {
  htm: "text/html",
  html: "text/html",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
} as const;

const genericBrowserMimeTypes = new Set(["", "application/octet-stream", "text/plain"]);
const supportedBrowserMimeTypes = new Set(Object.values(mimeByExtension));

export interface PreparedBrowserFile {
  readonly error: string | null;
  readonly file: File | null;
}

type PdfExtractor = (file: File) => Promise<{ readonly derivedText: string }>;

export const prepareBrowserFile = async (
  file: File,
  maximumBytes: number,
  extractPdf: PdfExtractor = async (pdf) =>
    (await import("./workers/pdf-extraction-client")).extractPdfInBrowser(pdf),
): Promise<PreparedBrowserFile> => {
  if (file.size === 0) return { error: "Choose a file that is not empty.", file: null };
  if (file.size > maximumBytes) {
    return { error: "This file is larger than the deployment allows.", file: null };
  }

  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const expectedMimeType = mimeByExtension[extension as keyof typeof mimeByExtension];
  if (expectedMimeType === undefined) {
    return { error: "Only HTML, Markdown, and PDF files are supported.", file: null };
  }
  const declaredMimeType = file.type.toLowerCase();
  if (
    !genericBrowserMimeTypes.has(declaredMimeType) &&
    !supportedBrowserMimeTypes.has(declaredMimeType as typeof expectedMimeType)
  ) {
    return { error: "Only HTML, Markdown, and PDF files are supported.", file: null };
  }
  if (!genericBrowserMimeTypes.has(declaredMimeType) && declaredMimeType !== expectedMimeType) {
    return { error: "The filename extension does not match the file type.", file: null };
  }
  const normalized = declaredMimeType === expectedMimeType
    ? file
    : new File([file], file.name, { type: expectedMimeType, lastModified: file.lastModified });

  if (normalized.type === "application/pdf") {
    const bytes = new Uint8Array(await normalized.slice(0, 5).arrayBuffer());
    if (new TextDecoder().decode(bytes) !== "%PDF-") {
      return { error: "This file does not contain a valid PDF signature.", file: null };
    }
    const extraction = await extractPdf(normalized);
    const finding = findFirstSensitiveContent(extraction.derivedText);
    if (finding !== null) {
      return { error: `This PDF may contain sensitive ${finding.label}.`, file: null };
    }
  } else {
    const bytes = new Uint8Array(await normalized.arrayBuffer());
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) {
        return { error: "Text artifacts cannot contain null bytes.", file: null };
      }
    } catch {
      return { error: "Text artifacts must use UTF-8 encoding.", file: null };
    }
  }

  return { error: null, file: normalized };
};
