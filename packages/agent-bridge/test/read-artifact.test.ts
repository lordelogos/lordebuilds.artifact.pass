import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { readArtifact } from "../src/tools/read-artifact";

const artifactId = "018f1f52-cbf1-7a5e-b66e-9ac829614b53";
const token = "s".repeat(32);
const shareUrl = `https://artifacts.example.test/a/${token}`;

const manifest = (source: Uint8Array) => ({
  protocol_version: 1,
  artifact_id: artifactId,
  filename: "large.md",
  mime_type: "text/markdown",
  byte_size: source.byteLength,
  sha256: createHash("sha256").update(source).digest("hex"),
  created_at: "2026-08-16T00:00:00.000Z",
  expires_at: "2026-08-16T00:30:00.000Z",
  extraction: { status: "not_applicable" },
});

const pdfManifest = (extraction: Record<string, unknown>) => ({
  protocol_version: 1,
  artifact_id: artifactId,
  filename: "report.pdf",
  mime_type: "application/pdf",
  byte_size: 1_024,
  sha256: "b".repeat(64),
  created_at: "2026-08-16T00:00:00.000Z",
  expires_at: "2026-08-16T00:30:00.000Z",
  extraction,
});

describe("read_artifact", () => {
  it("reconstructs exact source through deterministic bounded chunks", async () => {
    const source = new TextEncoder().encode("0123456789abcdef".repeat(10_000));
    const metadata = manifest(source);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest")) return Response.json(metadata);
      const cursor = url.searchParams.get("cursor");
      const offset = cursor === null ? 0 : Number(Buffer.from(cursor, "base64url").toString().split(":").at(-1));
      const limit = Number(url.searchParams.get("limit"));
      const bytes = source.subarray(offset, offset + limit);
      const nextOffset = offset + bytes.byteLength;
      return Response.json({
        protocol_version: 1,
        artifact_id: artifactId,
        encoding: "base64",
        byte_offset: offset,
        byte_length: bytes.byteLength,
        total_size: source.byteLength,
        sha256: metadata.sha256,
        data: Buffer.from(bytes).toString("base64"),
        next_cursor: nextOffset < source.byteLength
          ? Buffer.from(`${artifactId}:${nextOffset}`).toString("base64url")
          : null,
      });
    });

    const chunks: Uint8Array[] = [];
    let cursor: string | undefined;
    do {
      const result = await readArtifact({ shareUrl, ...(cursor === undefined ? {} : { cursor }), maxBytes: 32_768 }, {
        baseUrl: new URL("https://artifacts.example.test"),
        fetch,
      });
      chunks.push(Buffer.from(result.data, "base64"));
      cursor = result.next_cursor ?? undefined;
      expect(result.total_size).toBe(source.byteLength);
      expect(result.sha256).toBe(metadata.sha256);
    } while (cursor !== undefined);

    expect(Buffer.concat(chunks)).toEqual(Buffer.from(source));
  });

  it("returns page-separated PDF derived text with exact-source metadata", async () => {
    const derived = "--- Page 1 ---\nBorn digital text";
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(pdfManifest({
        status: "best_effort",
        extractor: "pdfjs-dist",
        extractor_version: "6.2.108",
        page_count: 1,
      })))
      .mockResolvedValueOnce(new Response(derived, {
        headers: { "content-type": "text/plain;charset=utf-8" },
      }));

    const result = await readArtifact({ shareUrl }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
    });

    expect(result.representation).toBe("derived");
    expect(result.text).toBe(derived);
    expect(result.manifest.extraction.status).toBe("best_effort");
    expect(result.exact_source_url).toBe(`${shareUrl}/raw`);
    expect(Buffer.from(result.data, "base64").toString("utf8")).toBe(derived);
  });

  it("returns honest metadata and an exact PDF resource when extraction is unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(pdfManifest({
      status: "unavailable",
      extractor: "pdfjs-dist",
      extractor_version: "6.2.108",
      reason: "No useful embedded text was found; OCR is not included.",
    })));

    const result = await readArtifact({ shareUrl }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
    });

    expect(result.representation).toBe("pdf_metadata");
    expect(result.byte_length).toBe(0);
    expect(result.manifest.extraction.status).toBe("unavailable");
    expect(result.exact_source_url).toBe(`${shareUrl}/raw`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["foreign origin", `https://evil.example/a/${token}`],
    ["credentials", `https://user:pass@artifacts.example.test/a/${token}`],
    ["fragment", `${shareUrl}#secret`],
    ["malformed path", "https://artifacts.example.test/not-an-artifact"],
  ])("rejects %s URLs before fetching", async (_label, candidate) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(readArtifact({ shareUrl: candidate }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
    })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid cursors before any network request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(readArtifact({ shareUrl, cursor: "not a cursor" }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
    })).rejects.toThrow(/cursor/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [302, "http://127.0.0.1/steal"],
    [307, "https://10.0.0.1/steal"],
    [308, "https://evil.example/steal"],
  ])("rejects redirect responses without following them", async (status, location) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status, headers: { location } }),
    );
    await expect(readArtifact({ shareUrl }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
    })).rejects.toThrow(/redirect/u);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it.each([
    [404, { protocol_version: 1, error: { code: "expired", message: "Artifact expired" } }],
    [200, { protocol_version: 1, filename: "missing fields" }],
  ])("handles expired or malformed responses without leaking URLs", async (status, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body, { status }));
    await expect(readArtifact({ shareUrl }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
    })).rejects.not.toThrow(shareUrl);
  });
});
