const bytesToHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = async (bytes) => bytesToHex(new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes),
));

export const sourceSha256 = async (bytes) =>
  digest(new Uint8Array(bytes));

export const createPayloadCommitmentFromSourceHash = async ({
  derivedHash = null,
  expiresInSeconds,
  extraction = { status: "not_applicable" },
  filename,
  mimeType,
  sourceHash,
}) => {
  return digest(new TextEncoder().encode(JSON.stringify([
    "artifact-share-upload-v2",
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
  ])));
};

export const createPayloadCommitment = async ({ bytes, derivedBytes, ...metadata }) =>
  createPayloadCommitmentFromSourceHash({
    ...metadata,
    derivedHash: derivedBytes === undefined ? null : await sourceSha256(derivedBytes),
    sourceHash: await sourceSha256(bytes),
  });
