import type { ExtractionMetadata } from "artifact-protocol";

export interface PdfExtractionRequest {
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface PdfPageText {
  readonly page: number;
  readonly text: string;
}

export interface PdfExtractionResult {
  readonly metadata: Exclude<ExtractionMetadata, { status: "not_applicable" }>;
  readonly pages: readonly PdfPageText[];
  readonly qualityWarnings?: readonly PdfQualityWarning[];
}

export type PdfQualityWarning = "layout_may_be_degraded";

export interface PdfRepresentationAdapter {
  readonly runtime: "browser" | "node";
  readonly extractor: string;
  readonly extractorVersion: string;
  extract(request: PdfExtractionRequest): Promise<PdfExtractionResult>;
}

export type PdfExtractionImplementation = (
  request: PdfExtractionRequest,
) => Promise<PdfExtractionResult>;

export interface PdfAdapterOptions {
  readonly extractor: string;
  readonly extractorVersion: string;
  readonly extract: PdfExtractionImplementation;
}
