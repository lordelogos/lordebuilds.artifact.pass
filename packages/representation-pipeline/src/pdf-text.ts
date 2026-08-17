import type { PdfExtractionResult, PdfPageText } from "./contracts";

const normalizePageText = (text: string): string =>
  text
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();

export const pdfPagesToText = (pages: readonly PdfPageText[]): string =>
  pages
    .map((page) => ({ ...page, text: normalizePageText(page.text) }))
    .filter((page) => page.text.length > 0)
    .map((page) => `--- Page ${page.page} ---\n${page.text}`)
    .join("\n\n");

export const createPdfExtractionResult = (
  pages: readonly PdfPageText[],
  extractor: string,
  extractorVersion: string,
): PdfExtractionResult => {
  const normalizedPages = pages.map((page) => ({
    page: page.page,
    text: normalizePageText(page.text),
  }));
  const usefulText = pdfPagesToText(normalizedPages);

  if (usefulText.length === 0) {
    return {
      metadata: {
        status: "unavailable",
        extractor,
        extractor_version: extractorVersion,
        reason: "No useful embedded text was found; OCR is not included.",
      },
      pages: normalizedPages,
      safetyCoverage: "incomplete",
    };
  }

  return {
    metadata: {
      status: "best_effort",
      extractor,
      extractor_version: extractorVersion,
      page_count: normalizedPages.length,
    },
    pages: normalizedPages,
    safetyCoverage: "incomplete",
  };
};
