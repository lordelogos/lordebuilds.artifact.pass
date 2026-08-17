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

const createType3Pdf = (): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type3 /Name /F1 /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 6 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [500] /Resources << >> >>",
    "<< /Length 36 >>\nstream\nBT /F1 72 Tf 72 650 Td (A) Tj ET\nendstream",
    "<< /Length 25 >>\nstream\n500 0 d0 0 0 500 700 re f\nendstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`
  ).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
};

const createMisleadingToUnicodePdf = (): Uint8Array => {
  const content = "BT /F1 72 Tf 72 650 Td (A) Tj ET";
  const unicodeMap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    "1 beginbfchar <41> <42> endbfchar",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Length ${unicodeMap.length} >>\nstream\n${unicodeMap}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`
  ).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
};

const createInvisibleTextPdf = (): Uint8Array => {
  const content = "BT /F1 18 Tf 3 Tr 72 650 Td (Hidden text) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
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

  it("marks Type3 glyph programs as incomplete even when they expose benign text", async () => {
    const result = await extractPdfInNode({ bytes: createType3Pdf() });

    expect(pdfPagesToText(result.pages)).toContain("A");
    expect(result.safetyCoverage).toBe("incomplete");
  });

  it("marks custom Unicode maps incomplete when rendered and extracted glyphs can disagree", async () => {
    const result = await extractPdfInNode({ bytes: createMisleadingToUnicodePdf() });

    expect(pdfPagesToText(result.pages)).toContain("B");
    expect(result.safetyCoverage).toBe("incomplete");
  });

  it("marks invisible text rendering modes incomplete", async () => {
    const result = await extractPdfInNode({ bytes: createInvisibleTextPdf() });

    expect(pdfPagesToText(result.pages)).toContain("Hidden text");
    expect(result.safetyCoverage).toBe("incomplete");
  });
});
