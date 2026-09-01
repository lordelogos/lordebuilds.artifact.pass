import {
  canonicalPdfProvenancePayload,
  pdfProvenanceReceiptSchema,
  type PdfProvenanceReceipt,
} from "artifact-protocol";

import type { ArtifactServiceBindings } from "../adapters/cloudflare-bindings";

type PdfProvenanceBindings = Pick<
  ArtifactServiceBindings,
  "PDF_PROVENANCE_PUBLIC_KEYS" | "PDF_PROVENANCE_RENDERERS"
> & Partial<Pick<ArtifactServiceBindings, "ARTIFACT_DB">>;

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

interface DeviceSigningKeyRow {
  public_key: string;
  key_revoked_at: number | null;
  token_revoked_at: number | null;
  token_expires_at: number;
}

const publicKeyForReceipt = async (
  keyId: string,
  bindings: PdfProvenanceBindings,
  now: number,
): Promise<string | null> => {
  if (bindings.ARTIFACT_DB !== undefined) {
    const row = await bindings.ARTIFACT_DB.prepare(
      `SELECT keys.public_key,
              keys.revoked_at AS key_revoked_at,
              tokens.revoked_at AS token_revoked_at,
              tokens.expires_at AS token_expires_at
       FROM device_signing_keys AS keys
       JOIN agent_tokens AS tokens ON tokens.id = keys.agent_token_id
       WHERE keys.key_id = ?`,
    ).bind(keyId).first<DeviceSigningKeyRow>();
    if (row !== null) {
      return row.key_revoked_at === null && row.token_revoked_at === null && row.token_expires_at > now
        ? row.public_key
        : null;
    }
  }
  return publicKeysFromBindings(bindings)[keyId] ?? null;
};

export const verifyPdfProvenance = async (
  receiptValue: unknown,
  expectedSourceSha256: string,
  expectedPdfSha256: string,
  bindings: PdfProvenanceBindings,
  now = Date.now(),
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
  const encodedKey = await publicKeyForReceipt(receipt.key_id, bindings, now);
  if (encodedKey === null) return null;
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
