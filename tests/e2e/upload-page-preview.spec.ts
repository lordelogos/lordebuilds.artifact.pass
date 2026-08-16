import { expect, test, type Page } from "@playwright/test";

const previewUrl = process.env.ARTIFACT_SHARE_PREVIEW_URL ?? "http://127.0.0.1:4173";

const shareToken = "S".repeat(43);

const mockUploadService = async (page: Page, onUpload?: (body: string) => void) => {
  await page.addInitScript(() => window.history.replaceState({}, "", "/upload"));
  await page.route("**/upload/policy", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      protocol_version: 1,
      supported_mime_types: ["text/html", "text/markdown", "application/pdf"],
      max_artifact_bytes: 26_214_400,
      max_source_chunk_bytes: 65_536,
      expiry: { maximum_seconds: 86_400, allowed_seconds: [900, 1800, 3600, 43_200, 86_400] },
    }),
  }));
  await page.route("**/upload/artifacts", async (route) => {
    const requestBody = route.request().postData() ?? "";
    onUpload?.(requestBody);
    const extraction = requestBody.includes("unavailable")
      ? {
          status: "unavailable",
          extractor: "pdfjs-dist",
          extractor_version: "6.2.108",
          reason: "No useful embedded text was found; OCR is not included.",
        }
      : {
          status: "best_effort",
          extractor: "pdfjs-dist",
          extractor_version: "6.2.108",
          page_count: 1,
        };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        protocol_version: 1,
        share_url: `https://artifacts.example/a/${shareToken}`,
        manifest: {
          protocol_version: 1,
          artifact_id: "00000000-0000-4000-8000-000000000004",
          filename: "browser-report.pdf",
          mime_type: "application/pdf",
          byte_size: 590,
          sha256: "a".repeat(64),
          created_at: "2026-08-16T12:00:00.000Z",
          expires_at: "2026-08-16T12:30:00.000Z",
          extraction,
        },
      }),
    });
  });
};

const createTextPdf = (text: string | null): Buffer => {
  const stream = text === null ? "q 1 0 0 1 0 0 cm Q" : `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
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

test.describe("local upload page preview", () => {
  test("renders the desktop and mobile upload surface", async ({ page }) => {
    await mockUploadService(page);
    await page.goto(previewUrl);
    await expect(page.getByRole("heading", { name: /Share the work/ })).toBeVisible();
    await expect(page.getByText("Drop one artifact here")).toBeVisible();
    await page.screenshot({ path: "test-results/u4-upload-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/u4-upload-mobile.png", fullPage: true });
  });

  test("runs born-digital PDF extraction in the browser worker before upload", async ({ page }) => {
    let multipartBody = "";
    await mockUploadService(page, (body) => {
      multipartBody = body;
    });
    await page.goto(previewUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "browser-report.pdf",
      mimeType: "application/pdf",
      buffer: createTextPdf("Born digital report"),
    });
    await page.getByRole("button", { name: "Create temporary link" }).click();
    await expect(page.getByRole("heading", { name: "The link is live." })).toBeVisible({ timeout: 20_000 });
    expect(multipartBody).toContain("best_effort");
    expect(multipartBody).toContain("Born digital report");
  });

  test("labels a PDF without an embedded text layer unavailable", async ({ page }) => {
    let multipartBody = "";
    await mockUploadService(page, (body) => {
      multipartBody = body;
    });
    await page.goto(previewUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "image-only-report.pdf",
      mimeType: "application/pdf",
      buffer: createTextPdf(null),
    });
    await page.getByRole("button", { name: "Create temporary link" }).click();
    await expect(page.getByRole("heading", { name: "The link is live." })).toBeVisible({ timeout: 20_000 });
    expect(multipartBody).toContain("unavailable");
    expect(multipartBody).toContain("No useful embedded text was found; OCR is not included.");
    expect(multipartBody).not.toContain('name="derived_text"');
  });
});
