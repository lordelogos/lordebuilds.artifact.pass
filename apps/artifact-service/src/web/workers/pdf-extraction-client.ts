import { createPdfExtractionResult, pdfPagesToText, type PdfExtractionResult } from "representation-pipeline";
import { getDocument, GlobalWorkerOptions, version } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface BrowserPdfExtraction {
  readonly result: PdfExtractionResult;
  readonly derivedText: string;
}

export const extractPdfInBrowser = async (file: File): Promise<BrowserPdfExtraction> => {
  const loadingTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
  });
  try {
    const document = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" ");
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
    const result = createPdfExtractionResult(pages, "pdfjs-dist", version);
    return { result, derivedText: pdfPagesToText(result.pages) };
  } catch {
    return {
      result: {
        metadata: {
          status: "unavailable",
          extractor: "pdfjs-dist",
          extractor_version: version,
          reason: "Embedded text extraction failed; the exact PDF is still available.",
        },
        pages: [],
      },
      derivedText: "",
    };
  } finally {
    await loadingTask.destroy();
  }
};
