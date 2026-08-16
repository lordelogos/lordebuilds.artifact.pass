import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createArtifactApplication } from "../src/server/index";
import { ARTIFACT_SCHEMA_SQL } from "../src/server/db/schema";

const agentToken = `as_${"W".repeat(43)}`;
const now = Date.parse("2026-08-16T12:00:00.000Z");

const digest = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const authorize = async () => {
  await env.ARTIFACT_DB.prepare(
    `INSERT INTO agent_tokens (
      id, token_hash, identity_subject, identity_email, scope, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 'artifact:create', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await digest(agentToken),
      "web-route-test",
      "web-route-test@example.com",
      now,
      now + 3_600_000,
    )
    .run();
};

const request = async (path: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(createArtifactApplication({ now: Date.now }).fetch(
    new Request(`https://artifacts.example${path}`, init),
    env,
  ));

const upload = async (
  filename: string,
  mimeType: string,
  source: string,
  extraction?: "best_effort" | "unavailable",
) => {
  await authorize();
  const form = new FormData();
  form.set("file", new File([source], filename, { type: mimeType }));
  form.set("expires_in_seconds", "900");
  if (extraction !== undefined) {
    form.set("extraction_status", extraction);
    form.set("extractor", "pdfjs-dist");
    form.set("extractor_version", "5.4.149");
    if (extraction === "best_effort") {
      form.set("page_count", "1");
      form.set("derived_text", "--- Page 1 ---\nReadable report");
    } else {
      form.set("extraction_reason", "No useful embedded text was found; OCR is not included.");
    }
  }
  const response = await request("/api/artifacts", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
    body: form,
  });
  expect(response.status).toBe(201);
  return response.json<{ share_url: string; manifest: { expires_at: string } }>();
};

beforeEach(async () => {
  await reset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await env.ARTIFACT_DB.exec(ARTIFACT_SCHEMA_SQL);
});

afterEach(() => vi.useRealTimers());

describe("safe human viewers", () => {
  it("renders hostile Markdown without executable or loading content while retaining exact bytes", async () => {
    const source = [
      "# Safe heading",
      "",
      '<img src="https://leak.example/track" onerror="document.body.dataset.pwned=1">',
      '<script>document.cookie="stolen"</script>',
      "[external](https://leak.example/referrer)",
    ].join("\n");
    const created = await upload("hostile.md", "text/markdown", source);
    const viewer = await fetch(created.share_url, undefined, request);
    const html = await viewer.text();

    expect(viewer.status).toBe(200);
    expect(viewer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(viewer.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("<h1>Safe heading</h1>");
    expect(html).not.toContain("<script>document.cookie");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('src="https://leak.example');
    expect(html).not.toContain('href="https://leak.example');

    const raw = await fetch(`${created.share_url}/raw`, undefined, request);
    expect(await raw.text()).toBe(source);
    expect(raw.headers.get("content-disposition")).toContain("attachment");
  });

  it("places sanitized HTML in a sandbox without scripts, external loads, or same-origin privilege", async () => {
    const source = '<h1>Readable</h1><script>parent.document.cookie</script><img src="https://leak.example/x"><a href="/api/artifacts">write</a>';
    const created = await upload("hostile.html", "text/html", source);
    const viewer = await fetch(created.share_url, undefined, request);
    const html = await viewer.text();

    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("parent.document.cookie");
    expect(html).not.toContain("https://leak.example");
    expect(html).not.toContain("/api/artifacts");
    expect(await (await fetch(`${created.share_url}/raw`, undefined, request)).text()).toBe(source);
  });

  it("embeds an inline PDF, supports ranges, and keeps exact download separate", async () => {
    const source = "%PDF-1.7\n0123456789\n%%EOF";
    const created = await upload("report.pdf", "application/pdf", source, "unavailable");
    const viewer = await fetch(created.share_url, undefined, request);
    const html = await viewer.text();
    expect(html).toContain(`<iframe`);
    expect(html).toContain(`${new URL(created.share_url).pathname}/content`);

    const content = await fetch(`${created.share_url}/content`, {
      headers: { range: "bytes=5-9" },
    }, request);
    expect(content.status).toBe(206);
    expect(content.headers.get("content-disposition")).toContain("inline");
    expect(content.headers.get("content-range")).toBe(`bytes 5-9/${source.length}`);
    expect(new TextDecoder().decode(await content.arrayBuffer())).toBe(source.slice(5, 10));

    const download = await fetch(`${created.share_url}/raw`, undefined, request);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(source);
  });

  it("contains an exact-cutoff open-page transition and denies every refresh at expiry", async () => {
    const created = await upload("handoff.md", "text/markdown", "# Temporary\n");
    const openPage = await fetch(created.share_url, undefined, request);
    const html = await openPage.text();
    expect(html).toContain(`data-expires-at="${created.manifest.expires_at}"`);
    expect(html).toContain("setTimeout");
    expect(html).toContain("Artifact expired");

    vi.setSystemTime(now + 900_000);
    expect((await fetch(created.share_url, undefined, request)).status).toBe(404);
    expect((await fetch(`${created.share_url}/content`, undefined, request)).status).toBe(404);
  });

  it.each(["/dashboard", "/history", "/settings"])("does not expose %s", async (path) => {
    expect((await request(path)).status).toBe(404);
  });
});

// Keep requests inside the same local Worker application rather than reaching the network.
async function fetch(
  url: string,
  init: RequestInit | undefined,
  requestApplication: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
  const parsed = new URL(url);
  return requestApplication(`${parsed.pathname}${parsed.search}`, init);
}
