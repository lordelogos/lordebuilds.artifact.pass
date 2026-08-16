import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FilePublicationJournal } from "../src/state/publication-journal";
import { publishArtifact } from "../src/tools/publish-artifact";
import { readArtifact } from "../src/tools/read-artifact";

const liveOrigin = process.env.ARTIFACT_SHARE_NETWORK_ORIGIN;
const liveSuite = liveOrigin === undefined ? describe.skip : describe;
let root = "";

const textPdf = (text: string): Buffer => {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
};

beforeAll(async () => {
  if (liveOrigin !== undefined) root = await mkdtemp(join(tmpdir(), "artifact-share-network-bridge-"));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

liveSuite("real network bridge flow", () => {
  it("publishes and reads Markdown, HTML, and PDF through the shared bridge implementation", async () => {
    if (liveOrigin === undefined) throw new Error("ARTIFACT_SHARE_NETWORK_ORIGIN is required");
    const baseUrl = new URL(liveOrigin);
    const openDevelopment = process.env.ARTIFACT_SHARE_NETWORK_OPEN_DEVELOPMENT === "1";
    const token = process.env.ARTIFACT_SHARE_TOKEN;
    if (!openDevelopment && token === undefined) throw new Error("ARTIFACT_SHARE_TOKEN is required for the Quick Tunnel bridge proof");
    const fixtures = [
      { name: "bridge-network.md", type: "text/markdown", bytes: Buffer.from("# Bridge network proof\n\nExact Markdown.\n") },
      { name: "bridge-network.html", type: "text/html", bytes: Buffer.from("<!doctype html><title>Bridge network proof</title><main>Exact HTML.</main>") },
      { name: "bridge-network.pdf", type: "application/pdf", bytes: textPdf("Bridge network PDF") },
    ] as const;
    const journal = new FilePublicationJournal(join(root, "publication-state.json"));
    for (const fixture of fixtures) {
      const path = join(root, fixture.name);
      await writeFile(path, fixture.bytes);
      const published = await publishArtifact({ path, expiresInSeconds: 3600 }, {
        baseUrl,
        workspaceRoots: [root],
        openDevelopment,
        ...(token === undefined ? {} : { token }),
        journal,
      });
      expect(new URL(published.share_url).origin).toBe(baseUrl.origin);
      expect(published.manifest.mime_type).toBe(fixture.type);
      const read = await readArtifact({ shareUrl: published.share_url }, { baseUrl, openDevelopment });
      expect(read.manifest.sha256).toBe(published.manifest.sha256);
      if (fixture.type !== "application/pdf") {
        expect(Buffer.from(read.data, "base64")).toEqual(fixture.bytes);
      } else {
        expect(read.exact_source_url).toBe(`${published.share_url}/raw`);
        expect(read.text).toContain("Bridge network PDF");
      }
    }
  }, 60_000);
});
