import {
  canonicalPdfProvenancePayload,
  pdfProvenanceReceiptSchema,
  type PdfProvenanceReceipt,
} from "artifact-protocol";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const decodeBase64Url = (value: string): Uint8Array => decodeBase64(
  value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="),
);

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
};

const publicKeysFromBindings = (
  bindings: Pick<ArtifactServiceBindings, "PDF_PROVENANCE_PUBLIC_KEYS">,
): Readonly<Record<string, string>> => {
  if (bindings.PDF_PROVENANCE_PUBLIC_KEYS === undefined) return {};
  const parsed: unknown = JSON.parse(bindings.PDF_PROVENANCE_PUBLIC_KEYS);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PDF_PROVENANCE_PUBLIC_KEYS must be a JSON object");
  }
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"
  ));
};

export const verifyPdfProvenance = async (
  receiptValue: unknown,
  expectedSourceSha256: string,
  expectedPdfSha256: string,
  bindings: Pick<ArtifactServiceBindings, "PDF_PROVENANCE_PUBLIC_KEYS" | "PDF_PROVENANCE_RENDERERS">,
): Promise<PdfProvenanceReceipt | null> => {
  const parsed = pdfProvenanceReceiptSchema.safeParse(receiptValue);
  if (!parsed.success) return null;
  const receipt = parsed.data;
  if (
    receipt.source_sha256 !== expectedSourceSha256 ||
    receipt.pdf_sha256 !== expectedPdfSha256
  ) return null;
  const allowedRenderers = new Set(
    (bindings.PDF_PROVENANCE_RENDERERS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  if (!allowedRenderers.has(`${receipt.renderer_id}@${receipt.renderer_version}`)) return null;
  const encodedKey = publicKeysFromBindings(bindings)[receipt.key_id];
  if (encodedKey === undefined) return null;
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeBase64(encodedKey)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const { signature: _signature, ...unsigned } = receipt;
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      toArrayBuffer(decodeBase64Url(receipt.signature)),
      toArrayBuffer(canonicalPdfProvenancePayload(unsigned)),
    ) ? receipt : null;
  } catch {
    return null;
  }
};
