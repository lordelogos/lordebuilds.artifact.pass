import { describe, expect, it } from "vitest";

import { qualifyAndSignPdfProvenance } from "../src/node-provenance";

const base64 = (value: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const signingKey = async (): Promise<string> => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const { privateKey } = pair as unknown as {
    privateKey: Parameters<typeof crypto.subtle.exportKey>[1];
  };
  return base64(await crypto.subtle.exportKey("pkcs8", privateKey));
};

const extraction = (text: string, safetyCoverage: "complete" | "incomplete" = "complete") => ({
  metadata: {
    status: "best_effort" as const,
    extractor: "fixture",
    extractor_version: "1",
    page_count: 1,
  },
  pages: [{ page: 1, text }],
  safetyCoverage,
});

describe("controlled PDF provenance", () => {
  it("signs the exact source and PDF hashes after visible-text qualification", async () => {
    const result = await qualifyAndSignPdfProvenance({
      canonicalSource: new TextEncoder().encode("Visible text"),
      pdfBytes: new TextEncoder().encode("%PDF-fixture"),
      extraction: extraction("Visible text"),
      keyId: "test-key",
      privateKeyPkcs8Base64: await signingKey(),
      generatedAt: "2026-08-16T12:00:00.000Z",
    });

    expect(result.receipt).toMatchObject({
      version: 1,
      key_id: "test-key",
      renderer_id: "artifact-share-qualified-pdf",
      renderer_version: "1",
    });
    expect(result.receipt.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.pdf_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  });

  it.each([
    ["different visible text", "Visible text", "Changed text", "does not match"],
    ["incomplete graphics coverage", "Visible text", "Visible text", "visible-content coverage"],
    ["invisible source character", "Visible\u200btext", "Visible text", "does not match"],
  ])("rejects %s", async (_label, source, visible, expected) => {
    await expect(qualifyAndSignPdfProvenance({
      canonicalSource: new TextEncoder().encode(source),
      pdfBytes: new TextEncoder().encode("%PDF-fixture"),
      extraction: extraction(visible, _label === "incomplete graphics coverage" ? "incomplete" : "complete"),
      keyId: "test-key",
      privateKeyPkcs8Base64: await signingKey(),
    })).rejects.toThrow(expected);
  });
});
