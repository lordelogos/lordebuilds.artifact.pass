import { expect, request as playwrightRequest, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishArtifact } from "../../packages/agent-bridge/src/tools/publish-artifact";
import { readArtifact } from "../../packages/agent-bridge/src/tools/read-artifact";

const configured =
  process.env.ARTIFACT_SHARE_E2E_BASE_URL !== undefined &&
  process.env.ARTIFACT_SHARE_E2E_AGENT_TOKEN !== undefined;
const agentToken = process.env.ARTIFACT_SHARE_E2E_AGENT_TOKEN ?? "not-configured";
const pdfPrivateKey = process.env.ARTIFACT_SHARE_E2E_PDF_PRIVATE_KEY;
test.use({ trace: "off" });

test.describe("live two-agent handoff", () => {
  test.skip(
    !configured,
    "Set a deployed base URL and scoped agent token; see docs/operations.md.",
  );

  test("one agent publishes while a human and a second agent read the same exact source", async ({
    baseURL,
    page,
    request,
  }) => {
    const marker = crypto.randomUUID();
    const source = `# Cross-agent handoff\n\n${"bounded source chunk\n".repeat(4_096)}\n${marker}\n`;
    const form = new FormData();
    form.set("file", new File([source], `handoff-${marker}.md`, { type: "text/markdown" }));
    form.set("expires_in_seconds", "900");
    form.set("extraction_status", "not_applicable");

    const uploaded = await request.post("/api/artifacts", {
      headers: { authorization: `Bearer ${agentToken}` },
      multipart: form,
    });
    expect(uploaded.status()).toBe(201);
    const result = await uploaded.json() as {
      share_url: string;
      manifest: { byte_size: number; sha256: string };
    };
    expect(result.share_url).toMatch(/\/a\/[A-Za-z0-9_-]{43}$/u);

    await page.goto(result.share_url);
    await expect(page.getByRole("heading", { name: "Cross-agent handoff" })).toBeVisible();
    await expect(page.getByText(marker, { exact: true })).toBeVisible();

    const secondAgent = await playwrightRequest.newContext({ baseURL });
    try {
      let cursor: string | null = null;
      const chunks: Buffer[] = [];
      do {
        const chunkResponse = await secondAgent.get(
          `${new URL(result.share_url).pathname}/source`,
          { params: { limit: "65536", ...(cursor === null ? {} : { cursor }) } },
        );
        expect(chunkResponse.status()).toBe(200);
        const chunk = await chunkResponse.json() as {
          data: string;
          next_cursor: string | null;
          total_size: number;
          sha256: string;
        };
        expect(chunk.total_size).toBe(result.manifest.byte_size);
        expect(chunk.sha256).toBe(result.manifest.sha256);
        chunks.push(Buffer.from(chunk.data, "base64"));
        cursor = chunk.next_cursor;
      } while (cursor !== null);
      expect(Buffer.concat(chunks).toString("utf8")).toBe(source);
    } finally {
      await secondAgent.dispose();
    }
  });

  test("keeps human PDFs metadata-only while controlled PDFs expose signed source", async () => {
    test.skip(pdfPrivateKey === undefined, "Set the hosted PDF signing key for this release gate.");
    const root = await mkdtemp(join(tmpdir(), "artifactpass-hosted-pdf-"));
    const visibleText = "Hosted controlled PDF handoff";
    const stream = `BT /F1 18 Tf 72 720 Td (${visibleText}) Tj ET`;
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
    const humanPath = join(root, "human.pdf");
    const controlledPath = join(root, "controlled.pdf");
    const canonicalPath = join(root, "controlled.md");
    await Promise.all([
      writeFile(humanPath, source),
      writeFile(controlledPath, source),
      writeFile(canonicalPath, visibleText),
    ]);
    const dependencies = {
      baseUrl: new URL(process.env.ARTIFACT_SHARE_E2E_BASE_URL ?? ""),
      workspaceRoots: [root],
      token: agentToken,
    };
    try {
      const human = await publishArtifact({ path: humanPath, expiresInSeconds: 900 }, dependencies);
      const humanRead = await readArtifact({ shareUrl: human.share_url }, dependencies);
      expect(human.manifest.pdf_trust).toEqual({ status: "human_only", reason: "provenance_missing" });
      expect(humanRead).toMatchObject({
        content_trust: "untrusted",
        representation: "pdf_metadata",
        byte_length: 0,
      });
      expect(humanRead.safety_notice).toContain("human-only");

      const controlled = await publishArtifact({
        path: controlledPath,
        canonicalSourcePath: canonicalPath,
        expiresInSeconds: 900,
      }, {
        ...dependencies,
        pdfProvenance: {
          keyId: "artifactpass-primary",
          privateKeyPkcs8Base64: pdfPrivateKey ?? "",
        },
      });
      const controlledRead = await readArtifact({ shareUrl: controlled.share_url }, dependencies);
      expect(controlled.manifest.pdf_trust.status).toBe("controlled");
      expect(controlledRead).toMatchObject({
        content_trust: "untrusted",
        representation: "derived",
        text: visibleText,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a hosted self-contained HTML handoff as exact source", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-hosted-html-"));
    const html = "<!doctype html><html><body><main>Hosted HTML handoff</main></body></html>";
    const path = join(root, "handoff.html");
    await writeFile(path, html);
    const dependencies = {
      baseUrl: new URL(process.env.ARTIFACT_SHARE_E2E_BASE_URL ?? ""),
      workspaceRoots: [root],
      token: agentToken,
    };
    try {
      const published = await publishArtifact({ path, expiresInSeconds: 900 }, dependencies);
      const received = await readArtifact({ shareUrl: published.share_url }, dependencies);
      expect(received).toMatchObject({
        content_trust: "untrusted",
        representation: "source",
        text: html,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
