import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { publishArtifact } from "../src/tools/publish-artifact";

const createdDirectories: string[] = [];
const agentToken = `as_${"t".repeat(43)}`;
const shareUrl = `https://artifacts.example.test/a/${"s".repeat(32)}`;

const workspace = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "artifact-share-bridge-"));
  createdDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdDirectories.splice(0).map(async (directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("publish_artifact", () => {
  it.each([
    ["handoff notes.md", "text/markdown", "# Exact source\n\nhello"],
    ["review page.html", "text/html", "<!doctype html><title>Exact source</title>"],
  ])("publishes exact bytes from paths containing spaces", async (filename, mimeType, source) => {
    const root = await workspace();
    const path = join(root, filename);
    await writeFile(path, source);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename,
        mime_type: mimeType,
        byte_size: Buffer.byteLength(source),
        sha256: "a".repeat(64),
        created_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2026-08-16T00:30:00.000Z",
        extraction: { status: "not_applicable" },
      },
      share_url: shareUrl,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    const result = await publishArtifact({ path, expiresInSeconds: 1800 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
    });

    const request = fetch.mock.calls[0]?.[1];
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(
      new TextEncoder().encode(source),
    );
    expect((form.get("file") as File).type).toBe(mimeType);
    expect(result.share_url).toMatch(/^https:\/\/artifacts\.example\.test\/a\//u);
  });

  it("rejects paths outside approved workspace roots and symlink escapes", async () => {
    const root = await workspace();
    const outside = await workspace();
    const target = join(outside, "secret.md");
    await writeFile(target, "secret");
    await mkdir(join(root, "nested"));
    const linked = join(root, "nested", "linked.md");
    await symlink(target, linked);

    const dependencies = {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch: vi.fn<typeof globalThis.fetch>(),
      token: agentToken,
      workspaceRoots: [root],
    };

    await expect(publishArtifact({ path: target, expiresInSeconds: 900 }, dependencies))
      .rejects.toThrow(/approved workspace/u);
    await expect(publishArtifact({ path: linked, expiresInSeconds: 900 }, dependencies))
      .rejects.toThrow(/approved workspace/u);
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported and signature-mismatched files", async () => {
    const root = await workspace();
    const unsupported = join(root, "notes.txt");
    const mismatched = join(root, "report.pdf");
    await writeFile(unsupported, "hello");
    await writeFile(mismatched, "not a pdf");
    const dependencies = {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch: vi.fn<typeof globalThis.fetch>(),
      token: agentToken,
      workspaceRoots: [root],
    };

    await expect(publishArtifact({ path: unsupported, expiresInSeconds: 900 }, dependencies))
      .rejects.toThrow(/supported/u);
    await expect(publishArtifact({ path: mismatched, expiresInSeconds: 900 }, dependencies))
      .rejects.toThrow(/PDF signature/u);
  });

  it("preserves exact PDF bytes and uploads truthful best-effort derived metadata", async () => {
    const root = await workspace();
    const path = join(root, "layout report.pdf");
    const bytes = new TextEncoder().encode("%PDF-exact-source");
    await writeFile(path, bytes);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename: "layout report.pdf",
        mime_type: "application/pdf",
        byte_size: bytes.byteLength,
        sha256: "a".repeat(64),
        created_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2026-08-16T00:30:00.000Z",
        extraction: {
          status: "best_effort",
          extractor: "pdfjs-dist",
          extractor_version: "6.2.108",
          page_count: 1,
        },
      },
      share_url: shareUrl,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await publishArtifact({ path, expiresInSeconds: 1800 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      extractPdf: async () => ({
        metadata: {
          status: "best_effort",
          extractor: "pdfjs-dist",
          extractor_version: "6.2.108",
          page_count: 1,
        },
        pages: [{ page: 1, text: "Table text" }],
        qualityWarnings: ["layout_may_be_degraded"],
      }),
    });

    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(bytes);
    expect(form.get("extraction_status")).toBe("best_effort");
    expect(form.get("extractor")).toBe("pdfjs-dist");
    expect(await (form.get("derived_text") as File).text()).toContain(
      "column or table layout may be degraded",
    );
  });

  it("publishes exact PDF bytes when optional extraction fails", async () => {
    const root = await workspace();
    const path = join(root, "encrypted-report.pdf");
    const bytes = new TextEncoder().encode("%PDF-exact-encrypted-source");
    await writeFile(path, bytes);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename: "encrypted-report.pdf",
        mime_type: "application/pdf",
        byte_size: bytes.byteLength,
        sha256: "a".repeat(64),
        created_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2026-08-16T00:30:00.000Z",
        extraction: { status: "unavailable", reason: "Embedded PDF text extraction was unavailable." },
      },
      share_url: shareUrl,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await expect(publishArtifact({ path, expiresInSeconds: 1800 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      extractPdf: async () => {
        throw new Error("encrypted PDF");
      },
    })).resolves.toMatchObject({ share_url: shareUrl });

    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(bytes);
    expect(form.get("extraction_status")).toBe("unavailable");
    expect(form.get("extraction_reason")).not.toContain("encrypted PDF");
    expect(form.get("derived_text")).toBeNull();
  });

  it("rejects a file changed between validation and upload", async () => {
    const root = await workspace();
    const path = join(root, "changing.md");
    await writeFile(path, "version one");
    let statCount = 0;

    await expect(publishArtifact({ path, expiresInSeconds: 900 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch: vi.fn<typeof globalThis.fetch>(),
      token: agentToken,
      workspaceRoots: [root],
      fileOperations: {
        realpath: async (value) => value,
        open: async () => ({
          readFile: async () => Buffer.from("version one"),
          stat: async () => {
            statCount += 1;
            return {
              dev: 1,
              ino: 2,
              mode: 0o100644,
              size: statCount === 1 ? 11 : 12,
              mtimeMs: statCount,
              ctimeMs: statCount,
              isFile: () => true,
            };
          },
          close: async () => undefined,
        }),
      },
    })).rejects.toThrow(/changed/u);
  });

  it("preserves a successful share result if the local file changes after dispatch", async () => {
    const source = "# stable upload snapshot";
    let changedAfterDispatch = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      changedAfterDispatch = true;
      return new Response(JSON.stringify({
        protocol_version: 1,
        manifest: {
          protocol_version: 1,
          artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
          filename: "snapshot.md",
          mime_type: "text/markdown",
          byte_size: Buffer.byteLength(source),
          sha256: "a".repeat(64),
          created_at: "2026-08-16T00:00:00.000Z",
          expires_at: "2026-08-16T00:30:00.000Z",
          extraction: { status: "not_applicable" },
        },
        share_url: shareUrl,
      }), { status: 201, headers: { "content-type": "application/json" } });
    });
    const stableStat = {
      dev: 1,
      ino: 2,
      mode: 0o100644,
      size: Buffer.byteLength(source),
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => true,
    };

    await expect(publishArtifact({ path: "snapshot.md", expiresInSeconds: 900 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: ["."],
      fileOperations: {
        realpath: async (value) => value,
        open: async () => ({
          readFile: async () => Buffer.from(source),
          stat: async () => changedAfterDispatch ? { ...stableStat, mtimeMs: 2 } : stableStat,
          close: async () => undefined,
        }),
      },
    })).resolves.toMatchObject({ share_url: shareUrl });
  });
});
