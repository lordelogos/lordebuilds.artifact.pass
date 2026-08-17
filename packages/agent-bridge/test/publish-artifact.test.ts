import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FilePublicationJournal } from "../src/state/publication-journal";
import { publishArtifactInputSchema } from "../src/tool-contract";
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
  it("defaults publication to one hour when the caller omits an expiry", () => {
    expect(publishArtifactInputSchema.parse({ path: "final.md" })).toEqual({
      path: "final.md",
      expires_in_seconds: 3600,
    });
  });

  it("rejects production publishing without a token before opening or dispatching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const realpath = vi.fn(async (value: string) => value);
    const openFile = vi.fn(async () => {
      throw new Error("artifact file should not be opened");
    });

    await expect(publishArtifact({ path: "artifact.md", expiresInSeconds: 900 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      workspaceRoots: ["."],
      fileOperations: { realpath, open: openFile },
    })).rejects.toThrow(/non-empty.*token/u);

    expect(realpath).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes without a token to the configured HTTP origin in open development mode", async () => {
    const root = await workspace();
    const path = join(root, "local.md");
    await writeFile(path, "# Local artifact");
    const localShareUrl = `http://127.0.0.1:8787/a/${"s".repeat(32)}`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename: "local.md",
        mime_type: "text/markdown",
        byte_size: 16,
        sha256: "a".repeat(64),
        created_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2026-08-16T00:30:00.000Z",
        extraction: { status: "not_applicable" },
      },
      share_url: localShareUrl,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await expect(publishArtifact({ path, expiresInSeconds: 900 }, {
      baseUrl: new URL("http://127.0.0.1:8787"),
      openDevelopment: true,
      fetch,
      workspaceRoots: [root],
    })).resolves.toMatchObject({ share_url: localShareUrl });

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

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

  it.each([
    [".env/report.md", "# otherwise safe"],
    ["report.md", `agent token: as_${"x".repeat(43)}`],
    ["report.md", `-----BEGIN ${"PRIVATE KEY"}-----\nnot-a-real-key`],
  ])("refuses sensitive path or content %s before dispatch", async (relativePath, source) => {
    const root = await workspace();
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(publishArtifact({ path, expiresInSeconds: 3600 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal: new FilePublicationJournal(join(root, "private-state.json")),
    })).rejects.toThrow(/sensitive|secret|credential|private key/iu);

    expect(fetch).not.toHaveBeenCalled();
    await expect(readFile(join(root, "private-state.json"), "utf8")).rejects.toThrow();
  });

  it("allows benign redacted examples and sensitive-looking near misses", async () => {
    const root = await workspace();
    const path = join(root, ".env.example.md");
    const source = [
      "# Setup notes",
      "ARTIFACT_SHARE_TOKEN=as_<redacted>",
      "https://artifacts.example.test/a/<token>",
      "-----BEGIN PUBLIC KEY-----",
    ].join("\n");
    await writeFile(path, source);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      manifest: {
        protocol_version: 1,
        artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
        filename: ".env.example.md",
        mime_type: "text/markdown",
        byte_size: Buffer.byteLength(source),
        sha256: "a".repeat(64),
        created_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2026-08-16T01:00:00.000Z",
        extraction: { status: "not_applicable" },
      },
      share_url: shareUrl,
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await expect(publishArtifact({ path, expiresInSeconds: 3600 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
    })).resolves.toMatchObject({ share_url: shareUrl });
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

  it("refuses a PDF before journal or network access when its safety extraction fails", async () => {
    const root = await workspace();
    const path = join(root, "encrypted-report.pdf");
    const bytes = new TextEncoder().encode("%PDF-exact-encrypted-source");
    await writeFile(path, bytes);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const journalPath = join(root, "private-state.json");

    await expect(publishArtifact({ path, expiresInSeconds: 1800 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal: new FilePublicationJournal(journalPath),
      extractPdf: async () => {
        throw new Error("encrypted PDF");
      },
    })).rejects.toThrow(/safety scan/iu);

    expect(fetch).not.toHaveBeenCalled();
    await expect(readFile(journalPath, "utf8")).rejects.toThrow();
  });

  it("refuses sensitive extracted PDF text before journal or network access", async () => {
    const root = await workspace();
    const path = join(root, "sensitive-report.pdf");
    await writeFile(path, "%PDF-safe-binary-wrapper");
    const journalPath = join(root, "private-state.json");
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(publishArtifact({ path, expiresInSeconds: 3600 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal: new FilePublicationJournal(journalPath),
      extractPdf: async () => ({
        metadata: {
          status: "best_effort",
          extractor: "fixture",
          extractor_version: "1",
          page_count: 1,
        },
        pages: [{ page: 1, text: `as_${"x".repeat(43)}` }],
      }),
    })).rejects.toThrow(/Derived PDF text.*sensitive/iu);

    expect(fetch).not.toHaveBeenCalled();
    await expect(readFile(journalPath, "utf8")).rejects.toThrow();
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

  it("rotates an acknowledged share token at the server-reported expiry", async () => {
    const root = await workspace();
    const path = join(root, "expiry.md");
    await writeFile(path, "# Expiring handoff\n");
    let now = 1_000;
    const journal = new FilePublicationJournal(join(root, "bridge-state.json"), {
      now: () => now,
    });
    const observedTokens: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("Expected a multipart upload");
      const token = String(form.get("share_token"));
      observedTokens.push(token);
      return new Response(JSON.stringify({
        protocol_version: 1,
        manifest: {
          protocol_version: 1,
          artifact_id: crypto.randomUUID(),
          filename: "expiry.md",
          mime_type: "text/markdown",
          byte_size: 19,
          sha256: "a".repeat(64),
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 3_000).toISOString(),
          extraction: { status: "not_applicable" },
        },
        share_url: `https://artifacts.example.test/a/${token}`,
      }), { status: 201, headers: { "content-type": "application/json" } });
    });
    const dependencies = {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal,
    };

    const original = await publishArtifact({ path, expiresInSeconds: 3 }, dependencies);
    now = 4_000;
    const replacement = await publishArtifact({ path, expiresInSeconds: 3 }, dependencies);

    expect(replacement.share_url).not.toBe(original.share_url);
    expect(observedTokens[1]).not.toBe(observedTokens[0]);
  });

  it("recovers the original publication after a committed response is lost and the bridge restarts", async () => {
    const root = await workspace();
    const path = join(root, "final.md");
    const journalPath = join(root, "bridge-state.json");
    await writeFile(path, "# Final handoff\n");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let committed: {
      attempt: string;
      token: string;
      commitment: string;
      publisher: string;
    } | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const form = init?.body as FormData;
      const current = {
        attempt: String(form.get("publication_attempt")),
        token: String(form.get("share_token")),
        commitment: String(form.get("payload_commitment")),
        publisher: new Headers(init?.headers).get("x-artifact-publisher") ?? "",
      };
      if (committed === undefined) {
        committed = current;
        throw new TypeError("connection closed after commit");
      }
      expect(current).toEqual(committed);
      return new Response(JSON.stringify({
        protocol_version: 1,
        manifest: {
          protocol_version: 1,
          artifact_id: "018f1f52-cbf1-7a5e-b66e-9ac829614b53",
          filename: "final.md",
          mime_type: "text/markdown",
          byte_size: 16,
          sha256: "a".repeat(64),
          created_at: "2026-08-16T00:00:00.000Z",
          expires_at: expiresAt,
          extraction: { status: "not_applicable" },
        },
        share_url: `https://artifacts.example.test/a/${committed.token}`,
      }), { status: 201, headers: { "content-type": "application/json" } });
    });

    await expect(publishArtifact({ path, expiresInSeconds: 3600 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal: new FilePublicationJournal(journalPath),
    })).rejects.toThrow("connection closed after commit");

    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    const recoveredJournal = new FilePublicationJournal(journalPath);
    await expect(publishArtifact({ path, expiresInSeconds: 3600 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal: recoveredJournal,
    })).resolves.toMatchObject({
      share_url: `https://artifacts.example.test/a/${committed?.token}`,
    });
    await expect(publishArtifact({ path, expiresInSeconds: 3600 }, {
      baseUrl: new URL("https://artifacts.example.test"),
      fetch,
      token: agentToken,
      workspaceRoots: [root],
      journal: recoveredJournal,
    })).resolves.toMatchObject({
      share_url: `https://artifacts.example.test/a/${committed?.token}`,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(readFile(journalPath, "utf8")).resolves.toContain(committed?.token ?? "missing");
  });
});
