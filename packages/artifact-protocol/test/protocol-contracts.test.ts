import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPIRY_POLICY,
  PROTOCOL_VERSION,
  artifactManifestSchema,
  expiryPolicySchema,
  sourceChunkSchema,
  uploadResponseSchema,
} from "../src/index";

const validManifest = {
  protocol_version: PROTOCOL_VERSION,
  artifact_id: "018f47a2-93c6-7fd0-9d0f-80b9ac47f005",
  filename: "handoff.md",
  mime_type: "text/markdown",
  byte_size: 128,
  sha256: "a".repeat(64),
  created_at: "2026-08-16T12:00:00.000Z",
  expires_at: "2026-08-16T12:30:00.000Z",
  extraction: {
    status: "not_applicable",
  },
} as const;

describe("artifact manifest", () => {
  it.each(["text/html", "text/markdown", "application/pdf"] as const)(
    "accepts the supported MIME type %s",
    (mimeType) => {
      expect(
        artifactManifestSchema.parse({
          ...validManifest,
          mime_type: mimeType,
          filename: mimeType === "application/pdf" ? "report.pdf" : validManifest.filename,
          extraction:
            mimeType === "application/pdf"
              ? {
                  status: "best_effort",
                  extractor: "pdfjs",
                  extractor_version: "5.4.54",
                  page_count: 2,
                }
              : validManifest.extraction,
        }),
      ).toBeDefined();
    },
  );

  it("rejects unknown formats", () => {
    expect(() =>
      artifactManifestSchema.parse({ ...validManifest, mime_type: "text/plain" }),
    ).toThrow();
  });

  it("rejects artifacts beyond the protocol size limit", () => {
    expect(() =>
      artifactManifestSchema.parse({
        ...validManifest,
        byte_size: 25 * 1024 * 1024 + 1,
      }),
    ).toThrow();
  });

  it("rejects malformed dates and expiry before creation", () => {
    expect(() =>
      artifactManifestSchema.parse({ ...validManifest, expires_at: "tomorrow" }),
    ).toThrow();
    expect(() =>
      artifactManifestSchema.parse({
        ...validManifest,
        expires_at: "2026-08-16T11:59:59.999Z",
      }),
    ).toThrow();
  });

  it("rejects incompatible protocol versions", () => {
    expect(() =>
      artifactManifestSchema.parse({ ...validManifest, protocol_version: 2 }),
    ).toThrow();
  });
});

describe("expiry policy", () => {
  it("accepts every default preset", () => {
    const policy = expiryPolicySchema.parse(DEFAULT_EXPIRY_POLICY);

    expect(policy.allowed_seconds).toEqual([900, 1800, 3600, 43200, 86400]);
    expect(policy.allowed_seconds.every((value) => value <= policy.maximum_seconds)).toBe(
      true,
    );
  });

  it("rejects duplicate, unordered, and over-maximum presets", () => {
    expect(() =>
      expiryPolicySchema.parse({ maximum_seconds: 3600, allowed_seconds: [900, 900] }),
    ).toThrow();
    expect(() =>
      expiryPolicySchema.parse({ maximum_seconds: 3600, allowed_seconds: [1800, 900] }),
    ).toThrow();
    expect(() =>
      expiryPolicySchema.parse({ maximum_seconds: 3600, allowed_seconds: [900, 7200] }),
    ).toThrow();
  });
});

describe("transport schemas", () => {
  it("accepts deterministic exact-source chunks", () => {
    expect(
      sourceChunkSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        artifact_id: validManifest.artifact_id,
        encoding: "base64",
        byte_offset: 0,
        byte_length: 5,
        total_size: 5,
        sha256: validManifest.sha256,
        data: "aGVsbG8=",
        next_cursor: null,
      }),
    ).toBeDefined();
  });

  it("accepts a complete upload response", () => {
    expect(
      uploadResponseSchema.parse({
        protocol_version: PROTOCOL_VERSION,
        manifest: validManifest,
        share_url: "https://artifacts.example.com/a/opaque-token",
      }),
    ).toBeDefined();
  });
});
