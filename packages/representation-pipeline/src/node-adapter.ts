import type { PdfAdapterOptions, PdfRepresentationAdapter } from "./contracts";

export const createNodePdfAdapter = (
  options: PdfAdapterOptions,
): PdfRepresentationAdapter => ({
  runtime: "node",
  extractor: options.extractor,
  extractorVersion: options.extractorVersion,
  extract: options.extract,
});
