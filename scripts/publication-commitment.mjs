const bytesToHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = async (bytes) => bytesToHex(new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes),
));

export const sourceSha256 = async (bytes) =>
  digest(bytes);

const stablePdfTrust = (pdfTrust) => {
  if (pdfTrust?.status !== "controlled") return pdfTrust;
  const { generated_at: _generatedAt, signature: _signature, ...receipt } = pdfTrust.receipt;
  return { status: "controlled", receipt };
};

export const createPayloadCommitmentFromSourceHash = async ({
  derivedHash = null,
  expiresInSeconds,
  extraction = { status: "not_applicable" },
  pdfTrust,
  filename,
  mimeType,
  sourceHash,
}) => {
  const effectivePdfTrust = pdfTrust ?? (
    mimeType === "application/pdf"
      ? { status: "human_only", reason: "provenance_missing" }
      : { status: "not_applicable" }
  );
  return digest(new TextEncoder().encode(JSON.stringify([
    "artifact-share-upload-v3",
    filename,
    mimeType,
    expiresInSeconds,
    sourceHash,
    [
      extraction.status,
      extraction.extractor ?? null,
      extraction.extractor_version ?? null,
      extraction.page_count ?? null,
      extraction.reason ?? null,
    ],
    derivedHash,
    stablePdfTrust(effectivePdfTrust),
  ])));
};

export const createPayloadCommitment = async ({ bytes, derivedBytes, ...metadata }) => {
  const [sourceHash, derivedHash] = await Promise.all([
    sourceSha256(bytes),
    derivedBytes === undefined ? Promise.resolve(null) : sourceSha256(derivedBytes),
  ]);
  return createPayloadCommitmentFromSourceHash({ ...metadata, derivedHash, sourceHash });
};
