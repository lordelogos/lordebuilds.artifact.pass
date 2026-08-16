import { describe, expect, it } from "vitest";

import { createPdfExtractionResult, pdfPagesToText } from "../src/pdf-text";

describe("PDF browser representation", () => {
  it("labels useful page-separated text as best effort", () => {
    const result = createPdfExtractionResult([
      { page: 1, text: "Opening page" },
      { page: 2, text: "Closing page" },
    ], "pdfjs-dist", "5.4.149");

    expect(result.metadata).toEqual({
      status: "best_effort",
      extractor: "pdfjs-dist",
      extractor_version: "5.4.149",
      page_count: 2,
    });
    expect(pdfPagesToText(result.pages)).toBe(
      "--- Page 1 ---\nOpening page\n\n--- Page 2 ---\nClosing page",
    );
  });

  it("labels image-only documents unavailable without a completeness claim", () => {
    const result = createPdfExtractionResult(
      [{ page: 1, text: "   " }],
      "pdfjs-dist",
      "5.4.149",
    );

    expect(result.metadata).toEqual({
      status: "unavailable",
      extractor: "pdfjs-dist",
      extractor_version: "5.4.149",
      reason: "No useful embedded text was found; OCR is not included.",
    });
    expect(pdfPagesToText(result.pages)).toBe("");
  });
});
