import {
  PDF_PROVENANCE_VERSION,
  PDF_QUALIFIER_ID,
  PDF_QUALIFIER_VERSION,
  canonicalPdfProvenancePayload,
  type PdfProvenanceReceipt,
} from "artifact-protocol";

import type { PdfExtractionResult } from "./contracts";

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
};

const encodeBase64Url = (value: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const normalizeVisibleText = (value: string): string => value
  .normalize("NFC")
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n")
  .replace(/[ \t]+\n/gu, "\n")
  .replace(/[ \t]{2,}/gu, " ")
  .trim();

const extractedVisibleText = (result: PdfExtractionResult): string =>
  result.pages.map((page) => page.text).join("\n\n");

export interface QualifyPdfProvenanceInput {
  readonly canonicalSource: Uint8Array;
  readonly pdfBytes: Uint8Array;
  readonly extraction: PdfExtractionResult;
  readonly keyId: string;
  readonly privateKeyPkcs8Base64: string;
  readonly generatedAt?: string;
}

export interface QualifiedPdfProvenance {
  readonly canonicalSource: Uint8Array;
  readonly receipt: PdfProvenanceReceipt;
}

export const qualifyAndSignPdfProvenance = async (
  input: QualifyPdfProvenanceInput,
): Promise<QualifiedPdfProvenance> => {
  if (input.extraction.metadata.status !== "best_effort" || input.extraction.safetyCoverage !== "complete") {
    throw new Error("Controlled PDF qualification requires complete visible-content coverage");
  }
  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(input.canonicalSource);
  } catch {
    throw new Error("Controlled PDF canonical source must be UTF-8 text");
  }
  if (normalizeVisibleText(sourceText) !== normalizeVisibleText(extractedVisibleText(input.extraction))) {
    throw new Error("Controlled PDF canonical source does not match the verified visible text");
  }

  const unsigned = {
    version: PDF_PROVENANCE_VERSION,
    key_id: input.keyId,
    renderer_id: PDF_QUALIFIER_ID,
    renderer_version: PDF_QUALIFIER_VERSION,
    source_sha256: await sha256(input.canonicalSource),
    pdf_sha256: await sha256(input.pdfBytes),
    generated_at: input.generatedAt ?? new Date().toISOString(),
  } as const;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(decodeBase64(input.privateKeyPkcs8Base64)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    Uint8Array.from(canonicalPdfProvenancePayload(unsigned)).buffer,
  );
  return {
    canonicalSource: input.canonicalSource,
    receipt: {
      ...unsigned,
      signature: encodeBase64Url(signature),
    },
  };
};
