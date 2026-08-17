import type {
  PdfAdapterOptions,
  PdfExtractionRequest,
  PdfExtractionResult,
  PdfPageText,
  PdfRepresentationAdapter,
} from "./contracts";
import { createPdfExtractionResult } from "./pdf-text";

export const createNodePdfAdapter = (
  options: PdfAdapterOptions,
): PdfRepresentationAdapter => ({
  runtime: "node",
  extractor: options.extractor,
  extractorVersion: options.extractorVersion,
  extract: options.extract,
});

interface PositionedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const pageText = (items: readonly PositionedText[]): { readonly text: string; readonly complex: boolean } => {
  const lines: PositionedText[][] = [];
  for (const item of [...items].sort((left, right) => {
    const vertical = right.y - left.y;
    return Math.abs(vertical) > 2 ? vertical : left.x - right.x;
  })) {
    const line = lines.find((candidate) => Math.abs((candidate[0]?.y ?? item.y) - item.y) <= 2);
    if (line === undefined) lines.push([item]);
    else line.push(item);
  }

  let complex = items.some((item) =>
    item.text.trim().length === 0 && item.width > Math.max(40, item.height * 4)
  );
  const text = lines.map((line) => {
    const sorted = [...line].sort((left, right) => left.x - right.x);
    return sorted.map((item, index) => {
      if (index === 0) return item.text;
      const previous = sorted[index - 1];
      if (previous === undefined) return item.text;
      const gap = item.x - (previous.x + previous.width);
      if (gap > Math.max(40, previous.height * 4)) complex = true;
      return `${gap > previous.height * 0.25 ? " " : ""}${item.text}`;
    }).join("");
  }).join("\n");

  return { text, complex };
};

export const extractPdfInNode = async (
  request: PdfExtractionRequest,
): Promise<PdfExtractionResult> => {
  const assertNotAborted = (): void => {
    if (request.signal?.aborted === true) throw request.signal.reason;
  };
  assertNotAborted();
  const { extractTextItems, getDocumentProxy, getResolvedPDFJS } = await import("unpdf");
  const document = await getDocumentProxy(request.bytes.slice());
  const pages: PdfPageText[] = [];
  let complexLayout = false;

  const extractedDocument = await extractTextItems(document);
  for (let pageNumber = 1; pageNumber <= extractedDocument.totalPages; pageNumber += 1) {
    assertNotAborted();
    const positioned = (extractedDocument.items[pageNumber - 1] ?? []).flatMap((item) => {
      if (item.str.length === 0) return [];
      return [{
        text: item.str,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      }];
    });
    const extracted = pageText(positioned);
    complexLayout ||= extracted.complex;
    pages.push({ page: pageNumber, text: extracted.text });
  }

  const { OPS, version } = await getResolvedPDFJS();
  const result = createPdfExtractionResult(pages, "pdfjs-dist", version);
  const unsupportedRenderingOperations = new Set([
    OPS.shadingFill,
    OPS.beginInlineImage,
    OPS.beginImageData,
    OPS.paintXObject,
    OPS.paintFormXObjectBegin,
    OPS.beginGroup,
    OPS.beginAnnotation,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintSolidColorImageMask,
    OPS.constructPath,
    OPS.rawFillPath,
  ]);
  let hasUnsupportedRendering = false;
  for (let pageNumber = 1; pageNumber <= extractedDocument.totalPages; pageNumber += 1) {
    assertNotAborted();
    const page = await document.getPage(pageNumber);
    const operatorList = await page.getOperatorList();
    hasUnsupportedRendering ||= operatorList.fnArray.some((operation) =>
      unsupportedRenderingOperations.has(operation)
    );
  }
  const [attachments, javaScriptActions] = await Promise.all([
    document.getAttachments(),
    document.getJSActions(),
  ]);
  const safetyCoverage = result.metadata.status === "best_effort" &&
      !hasUnsupportedRendering &&
      (attachments === null || attachments.size === 0) &&
      javaScriptActions === null
    ? "complete"
    : "incomplete";
  return {
    ...result,
    safetyCoverage,
    ...(complexLayout && result.metadata.status === "best_effort"
      ? { qualityWarnings: ["layout_may_be_degraded" as const] }
      : {}),
  };
};
