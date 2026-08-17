import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPayloadCommitment } from "../../../scripts/publication-commitment.mjs";
import { qualifyAndSignPdfProvenance } from "representation-pipeline/node-provenance";

import { createArtifactApplication } from "../src/server/index";
import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";

interface UploadOptions {
  readonly bytes: Uint8Array | string;
  readonly filename: string;
  readonly mimeType: string;
  readonly expiresInSeconds?: number;
  readonly extractionStatus?: "best_effort" | "unavailable";
  readonly derivedText?: string;
}

const testBindings = (overrides: Record<string, unknown> = {}) => ({
  ...env,
  ...overrides,
});

const storageTestAgentToken = `as_${"A".repeat(43)}`;

const authorizeStorageTestAgent = async () => {
  await env.ARTIFACT_DB.prepare(
    `INSERT OR IGNORE INTO agent_tokens (
      id, token_hash, identity_subject, identity_email, scope, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 'artifact:create', ?, ?)`,
  )
    .bind(
      "00000000-0000-4000-8000-000000000001",
      await digest(storageTestAgentToken),
      "storage-test-user",
      "storage-test@example.com",
      Date.now(),
      Date.now() + 60 * 60 * 1000,
    )
    .run();
};

const upload = async (options: UploadOptions, overrides: Record<string, unknown> = {}) => {
  await authorizeStorageTestAgent();
  const form = new FormData();
  const fileBody =
    typeof options.bytes === "string" ? options.bytes : Uint8Array.from(options.bytes).buffer;
  form.set("file", new File([fileBody], options.filename, { type: options.mimeType }));
  form.set("expires_in_seconds", String(options.expiresInSeconds ?? 900));
  if (options.extractionStatus !== undefined) {
    form.set("extraction_status", options.extractionStatus);
    if (options.extractionStatus === "best_effort") {
      form.set("extractor", "fixture-extractor");
      form.set("extractor_version", "1.0.0");
      form.set("page_count", "1");
    }
  }
  if (options.derivedText !== undefined) form.set("derived_text", options.derivedText);

  return createArtifactApplication().fetch(
    new Request("https://artifacts.example/api/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${storageTestAgentToken}` },
      body: form,
    }),
    testBindings(overrides),
  );
};

const expectUpload = async (options: UploadOptions) => {
  const response = await upload(options);
  expect(response.status).toBe(201);
  return response.json<{
    share_url: string;
    manifest: { sha256: string; byte_size: number; mime_type: string };
  }>();
};

const requestShare = (url: string, suffix = "", init?: RequestInit) =>
  createArtifactApplication().fetch(
    new Request(`${url}${suffix}`, init),
    testBindings(),
  );

const digest = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const base64 = (value: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const idempotentUpload = async (
  source: string,
  attempt: string,
  shareToken: string,
  overrides: Record<string, unknown> = {},
) => {
  const form = new FormData();
  form.set("file", new File([source], "handoff.md", { type: "text/markdown" }));
  form.set("expires_in_seconds", "3600");
  form.set("publication_attempt", attempt);
  form.set("share_token", shareToken);
  form.set("payload_commitment", await createPayloadCommitment({
    bytes: new TextEncoder().encode(source),
    expiresInSeconds: 3600,
    filename: "handoff.md",
    mimeType: "text/markdown",
  }));
  return createArtifactApplication({ allowUnauthenticatedUploads: true }).fetch(
    new Request("http://127.0.0.1:8787/api/artifacts", {
      method: "POST",
      headers: { "x-artifact-publisher": "local-publisher-01" },
      body: form,
    }),
    testBindings(overrides),
  );
};

describe("private artifact routes", () => {
  beforeEach(async () => {
    await reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    await env.ARTIFACT_DB.exec(ARTIFACT_SCHEMA_SQL);
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    {
      filename: "exact.html",
      mimeType: "text/html",
      bytes: "<!doctype html>\n<h1>Exact</h1>\n",
    },
    {
      filename: "handoff.md",
      mimeType: "text/markdown",
      bytes: "# Exact\n\nTwo lines.\n",
    },
    {
      filename: "report.pdf",
      mimeType: "application/pdf",
      bytes: "%PDF-1.7\nfixture\n%%EOF",
      extractionStatus: "unavailable" as const,
    },
  ])("round-trips exact $mimeType bytes", async (fixture) => {
    const created = await expectUpload(fixture);
    const raw = await requestShare(created.share_url, "/raw");

    expect(raw.status).toBe(200);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(
      new TextEncoder().encode(fixture.bytes),
    );
    expect(raw.headers.get("cache-control")).toContain("no-store");
    expect(created.manifest.sha256).toBe(await digest(fixture.bytes));

    const token = new URL(created.share_url).pathname.split("/").pop() ?? "";
    const row = await env.ARTIFACT_DB.prepare(
      "SELECT share_token_hash FROM artifacts",
    ).first<{ share_token_hash: string }>();
    expect(row?.share_token_hash).toBe(await digest(token));
  });

  it("keeps an ordinary uploaded PDF human-only with no agent-readable text", async () => {
    const source = "%PDF-1.7\nexact-source\n%%EOF";
    const created = await expectUpload({
      filename: "report.pdf",
      mimeType: "application/pdf",
      bytes: source,
      extractionStatus: "unavailable",
    });

    const manifest = await requestShare(created.share_url, "/manifest");
    await expect(manifest.json()).resolves.toMatchObject({
      mime_type: "application/pdf",
      extraction: { status: "unavailable" },
      pdf_trust: { status: "human_only", reason: "provenance_missing" },
    });
    const derived = await requestShare(created.share_url, "/derived");
    expect(derived.status).toBe(404);
    const raw = await requestShare(created.share_url, "/raw");
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toBe(source);
  });

  it("accepts a hash-bound signed PDF source and rejects a forged receipt", async () => {
    await authorizeStorageTestAgent();
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const { privateKey, publicKey } = keyPair as unknown as {
      privateKey: Parameters<typeof crypto.subtle.exportKey>[1];
      publicKey: Parameters<typeof crypto.subtle.exportKey>[1];
    };
    const privateKeyPkcs8Base64 = base64(await crypto.subtle.exportKey("pkcs8", privateKey));
    const publicKeyBase64 = base64(await crypto.subtle.exportKey("raw", publicKey));
    const canonicalSource = new TextEncoder().encode("Verified visible text");
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\nverified-fixture\n%%EOF");
    const qualified = await qualifyAndSignPdfProvenance({
      canonicalSource,
      pdfBytes,
      extraction: {
        metadata: {
          status: "best_effort",
          extractor: "fixture",
          extractor_version: "1",
          page_count: 1,
        },
        pages: [{ page: 1, text: "Verified visible text" }],
        safetyCoverage: "complete",
      },
      keyId: "test-key",
      privateKeyPkcs8Base64,
      generatedAt: "2026-08-16T12:00:00.000Z",
    });
    const bindings = testBindings({
      PDF_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ "test-key": publicKeyBase64 }),
      PDF_PROVENANCE_RENDERERS: "artifact-share-qualified-pdf@1",
    });
    const send = (receipt: unknown) => {
      const form = new FormData();
      form.set("file", new File([pdfBytes], "verified.pdf", { type: "application/pdf" }));
      form.set("expires_in_seconds", "900");
      form.set("extraction_status", "best_effort");
      form.set("extractor", "fixture");
      form.set("extractor_version", "1");
      form.set("page_count", "1");
      form.set("derived_text", new File([canonicalSource], "verified.pdf.txt", { type: "text/plain" }));
      form.set("pdf_provenance", JSON.stringify(receipt));
      return createArtifactApplication().fetch(new Request("https://artifacts.example/api/artifacts", {
        method: "POST",
        headers: { authorization: `Bearer ${storageTestAgentToken}` },
        body: form,
      }), bindings);
    };

    const created = await send(qualified.receipt);
    expect(created.status).toBe(201);
    const result = await created.json<{ share_url: string; manifest: { pdf_trust: { status: string } } }>();
    expect(result.manifest.pdf_trust.status).toBe("controlled");
    const derived = await createArtifactApplication().fetch(
      new Request(`${result.share_url}/derived`, { headers: { range: "bytes=0-20" } }),
      bindings,
    );
    expect(derived.status).toBe(206);
    await expect(derived.text()).resolves.toBe("Verified visible text");

    const revokedManifest = await createArtifactApplication().fetch(
      new Request(`${result.share_url}/manifest`),
      testBindings({ PDF_PROVENANCE_PUBLIC_KEYS: "{}", PDF_PROVENANCE_RENDERERS: "" }),
    );
    await expect(revokedManifest.json()).resolves.toMatchObject({
      pdf_trust: { status: "human_only", reason: "provenance_invalid" },
    });
    const revokedDerived = await createArtifactApplication().fetch(
      new Request(`${result.share_url}/derived`),
      testBindings({ PDF_PROVENANCE_PUBLIC_KEYS: "{}", PDF_PROVENANCE_RENDERERS: "" }),
    );
    expect(revokedDerived.status).toBe(404);

    const row = await env.ARTIFACT_DB.prepare("SELECT derived_object_key FROM artifacts").first<{
      derived_object_key: string;
    }>();
    await env.ARTIFACTS.put(row?.derived_object_key ?? "", "replacement", {
      customMetadata: { sha256: "0".repeat(64) },
    });
    const replacedDerived = await createArtifactApplication().fetch(
      new Request(`${result.share_url}/derived`),
      bindings,
    );
    expect(replacedDerived.status).toBe(404);

    const forged = { ...qualified.receipt, pdf_sha256: "0".repeat(64) };
    const rejected = await send(forged);
    expect(rejected.status).toBe(400);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(1);
  });

  it("serves deterministic bounded chunks that reconstruct a large exact source", async () => {
    const source = "a".repeat(70_000) + "THE-END";
    const created = await expectUpload({
      filename: "large.md",
      mimeType: "text/markdown",
      bytes: source,
    });

    const firstResponse = await requestShare(created.share_url, "/source");
    const first = await firstResponse.json<{
      data: string;
      byte_length: number;
      next_cursor: string;
    }>();
    expect(first.byte_length).toBe(65_536);
    const secondResponse = await requestShare(
      created.share_url,
      `/source?cursor=${encodeURIComponent(first.next_cursor)}`,
    );
    const second = await secondResponse.json<{ data: string; next_cursor: null }>();
    const reconstructed = atob(first.data) + atob(second.data);
    expect(reconstructed).toBe(source);
    expect(second.next_cursor).toBeNull();

    const oversized = await requestShare(created.share_url, "/source?limit=65537");
    expect(oversized.status).toBe(400);
    const wrongCursor = await requestShare(created.share_url, "/source?cursor=not-a-cursor");
    expect(wrongCursor.status).toBe(400);
  });

  it("supports satisfiable PDF byte ranges and rejects invalid ranges", async () => {
    const source = "%PDF-1.7\n0123456789\n%%EOF";
    const created = await expectUpload({
      filename: "range.pdf",
      mimeType: "application/pdf",
      bytes: source,
      extractionStatus: "unavailable",
    });

    const partial = await requestShare(created.share_url, "/raw", {
      headers: { Range: "bytes=5-9" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 5-9/${source.length}`);
    expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe(source.slice(5, 10));

    const invalid = await requestShare(created.share_url, "/raw", {
      headers: { Range: "bytes=999-1000" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${source.length}`);
  });

  it.each([
    ["unsupported media", { filename: "file.txt", mimeType: "text/plain", bytes: "hello" }, 415],
    ["extension mismatch", { filename: "file.pdf", mimeType: "text/markdown", bytes: "hello" }, 400],
    ["path traversal", { filename: "../file.md", mimeType: "text/markdown", bytes: "hello" }, 400],
    [
      "invalid PDF signature",
      { filename: "file.pdf", mimeType: "application/pdf", bytes: "not-pdf", extractionStatus: "unavailable" },
      400,
    ],
    [
      "invalid UTF-8",
      { filename: "file.md", mimeType: "text/markdown", bytes: new Uint8Array([0xff]) },
      400,
    ],
    ["disallowed expiry", { filename: "file.md", mimeType: "text/markdown", bytes: "hello", expiresInSeconds: 901 }, 400],
  ] as const)("rejects %s", async (_name, options, status) => {
    const response = await upload(options);
    expect(response.status).toBe(status);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(0);
  });

  it("returns the original URL without a second D1 row or R2 object after a response-loss retry", async () => {
    const attempt = crypto.randomUUID();
    const shareToken = "R".repeat(43);

    const first = await idempotentUpload("# Final\n", attempt, shareToken);
    const second = await idempotentUpload("# Final\n", attempt, shareToken);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = await first.json<{ share_url: string }>();
    const secondBody = await second.json<{ share_url: string }>();
    expect(secondBody.share_url).toBe(firstBody.share_url);
    expect(firstBody.share_url).toBe(`http://127.0.0.1:8787/a/${shareToken}`);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(1);
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(1);
    const row = await env.ARTIFACT_DB.prepare(
      "SELECT share_token_hash, publisher_id, publication_attempt, payload_commitment FROM artifacts",
    ).first<{
      share_token_hash: string;
      publisher_id: string;
      publication_attempt: string;
      payload_commitment: string;
    }>();
    expect(row).toEqual({
      share_token_hash: await digest(shareToken),
      publisher_id: `local:${await digest("local-publisher-01")}`,
      publication_attempt: attempt,
      payload_commitment: await createPayloadCommitment({
        bytes: new TextEncoder().encode("# Final\n"),
        expiresInSeconds: 3600,
        filename: "handoff.md",
        mimeType: "text/markdown",
      }),
    });
  });

  it("binds hosted idempotency to the authenticated principal instead of a client header", async () => {
    await authorizeStorageTestAgent();
    const source = "# Hosted\n";
    const form = new FormData();
    form.set("file", new File([source], "handoff.md", { type: "text/markdown" }));
    form.set("expires_in_seconds", "3600");
    form.set("publication_attempt", crypto.randomUUID());
    form.set("share_token", "V".repeat(43));
    form.set("payload_commitment", await createPayloadCommitment({
      bytes: new TextEncoder().encode(source),
      expiresInSeconds: 3600,
      filename: "handoff.md",
      mimeType: "text/markdown",
    }));

    const response = await createArtifactApplication().fetch(
      new Request("https://artifacts.example/api/artifacts", {
        method: "POST",
        headers: {
          authorization: `Bearer ${storageTestAgentToken}`,
          "x-artifact-publisher": "client-controlled-publisher",
        },
        body: form,
      }),
      testBindings(),
    );

    expect(response.status).toBe(201);
    expect(await env.ARTIFACT_DB.prepare("SELECT publisher_id FROM artifacts").first("publisher_id"))
      .toBe(`agent:${await digest("00000000-0000-4000-8000-000000000001")}`);
  });

  it("rejects attempt reuse with a different payload or share token without another write", async () => {
    const attempt = crypto.randomUUID();
    expect((await idempotentUpload("# First\n", attempt, "S".repeat(43))).status).toBe(201);

    expect((await idempotentUpload("# Changed\n", attempt, "S".repeat(43))).status).toBe(409);
    expect((await idempotentUpload("# First\n", attempt, "T".repeat(43))).status).toBe(409);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(1);
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(1);
  });

  it("refuses sensitive content before D1 or R2 writes", async () => {
    const response = await idempotentUpload(
      `as_${"x".repeat(43)}`,
      crypto.randomUUID(),
      "U".repeat(43),
    );

    expect(response.status).toBe(400);
    expect(await env.ARTIFACT_DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first("count"))
      .toBe(0);
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
  });

  it("rejects input over the configured size before storage", async () => {
    const response = await upload(
      { filename: "file.md", mimeType: "text/markdown", bytes: "123456789" },
      { MAX_ARTIFACT_BYTES: "8" },
    );
    expect(response.status).toBe(413);
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
  });

  it("requires the disabled-by-default internal upload seam and exposes no list route", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "file.md", { type: "text/markdown" }));
    form.set("expires_in_seconds", "900");
    const noBinding = await createArtifactApplication().fetch(
      new Request("https://artifacts.example/api/artifacts", { method: "POST", body: form }),
      env,
    );
    expect(noBinding.status).toBe(404);

    const list = await createArtifactApplication().fetch(
      new Request("https://artifacts.example/api/artifacts"),
      testBindings(),
    );
    expect(list.status).toBe(404);
  });

  it("denies random tokens and every representation at the exact expiry cutoff", async () => {
    const createdAt = new Date("2026-08-16T12:00:00.000Z");
    const { share_url: shareUrl } = await expectUpload({
      filename: "handoff.md",
      mimeType: "text/markdown",
      bytes: "# Exact\n",
    });
    const random = await requestShare(
      ["https://artifacts.example", "a", "A".repeat(43)].join("/"),
      "/manifest",
    );
    expect(random.status).toBe(404);

    vi.setSystemTime(new Date(createdAt.getTime() + 900_000));
    for (const suffix of ["", "/manifest", "/raw", "/source", "/derived"]) {
      const response = await requestShare(shareUrl, suffix);
      expect(response.status, suffix).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("makes a record unreachable when its private object disappears", async () => {
    const created = await expectUpload({
      filename: "handoff.md",
      mimeType: "text/markdown",
      bytes: "# Exact\n",
    });
    const row = await env.ARTIFACT_DB.prepare("SELECT id, object_key FROM artifacts").first<{
      id: string;
      object_key: string;
    }>();
    await env.ARTIFACTS.delete(row?.object_key ?? "missing");

    const response = await requestShare(created.share_url, "/raw");
    expect(response.status).toBe(404);
    expect(
      await env.ARTIFACT_DB.prepare("SELECT status FROM artifacts WHERE id = ?")
        .bind(row?.id)
        .first("status"),
    ).toBe("cleanup_pending");
  });
});
