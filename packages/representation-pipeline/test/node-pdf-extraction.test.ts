import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { extractPdfInNode, pdfPagesToText } from "../src/index";

const createTextPdf = async (
  pages: readonly ((document: PDFDocument) => Promise<void>)[],
): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  for (const draw of pages) await draw(document);
  return document.save({ useObjectStreams: false });
};

describe("Node PDF extraction", () => {
  it("extracts born-digital text page-by-page and labels it best effort", async () => {
    const bytes = await createTextPdf([
      async (document) => {
        const page = document.addPage();
        page.drawText("Opening page", { x: 50, y: 700, font: await document.embedFont(StandardFonts.Helvetica) });
      },
      async (document) => {
        const page = document.addPage();
        page.drawText("Closing page", { x: 50, y: 700, font: await document.embedFont(StandardFonts.Helvetica) });
      },
    ]);

    const result = await extractPdfInNode({ bytes });

    expect(result.metadata).toMatchObject({
      status: "best_effort",
      extractor: "pdfjs-dist",
      page_count: 2,
    });
    expect(result.safetyCoverage).toBe("complete");
    expect(pdfPagesToText(result.pages)).toContain("--- Page 1 ---\nOpening page");
    expect(pdfPagesToText(result.pages)).toContain("--- Page 2 ---\nClosing page");
  });

  it("flags multi-column or table-like spacing as a degraded layout", async () => {
    const bytes = await createTextPdf([
      async (document) => {
        const page = document.addPage();
        const font = await document.embedFont(StandardFonts.Helvetica);
        page.drawText("Left column", { x: 50, y: 700, font });
        page.drawText("Right column", { x: 350, y: 700, font });
        page.drawText("Row label", { x: 50, y: 650, font });
        page.drawText("Row value", { x: 350, y: 650, font });
      },
    ]);

    const result = await extractPdfInNode({ bytes });

    expect(result.metadata.status).toBe("best_effort");
    expect(result.qualityWarnings).toContain("layout_may_be_degraded");
  });

  it("reports image-only or blank PDFs as unavailable without claiming completeness", async () => {
    const document = await PDFDocument.create();
    document.addPage();

    const result = await extractPdfInNode({ bytes: await document.save({ useObjectStreams: false }) });

    expect(result.metadata).toMatchObject({
      status: "unavailable",
      extractor: "pdfjs-dist",
    });
    expect(result.metadata).toHaveProperty("reason");
    expect(result.safetyCoverage).toBe("incomplete");
    expect(pdfPagesToText(result.pages)).toBe("");
  });

  it("marks PDFs with unscanned rendered graphics as incomplete", async () => {
    const bytes = await createTextPdf([
      async (document) => {
        const page = document.addPage();
        page.drawText("Visible text", {
          x: 50,
          y: 700,
          font: await document.embedFont(StandardFonts.Helvetica),
        });
        page.drawRectangle({ x: 50, y: 650, width: 100, height: 20 });
      },
    ]);

    const result = await extractPdfInNode({ bytes });

    expect(result.metadata.status).toBe("best_effort");
    expect(result.safetyCoverage).toBe("incomplete");
  });
});
