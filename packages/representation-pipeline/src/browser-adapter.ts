import type { PdfAdapterOptions, PdfRepresentationAdapter } from "./contracts";

export const createBrowserPdfAdapter = (
  options: PdfAdapterOptions,
): PdfRepresentationAdapter => ({
  runtime: "browser",
  extractor: options.extractor,
  extractorVersion: options.extractorVersion,
  extract: options.extract,
});
