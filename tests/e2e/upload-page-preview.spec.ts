import { expect, test, type Page } from "@playwright/test";

const previewUrl = process.env.ARTIFACT_SHARE_PREVIEW_URL ?? "http://127.0.0.1:4173";
const uploadUrl = new URL("/upload", previewUrl).href;

const shareToken = "S".repeat(43);

const mockUploadService = async (
  page: Page,
  onUpload?: (body: string) => void,
  authenticated: () => boolean = () => true,
) => {
  await page.route("**/upload/preflight", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      authenticated: authenticated(),
      policy: {
        protocol_version: 1,
        supported_mime_types: ["text/html", "text/markdown", "application/pdf"],
        max_artifact_bytes: 26_214_400,
        max_source_chunk_bytes: 65_536,
        expiry: { maximum_seconds: 86_400, allowed_seconds: [900, 1800, 3600, 43_200, 86_400] },
      },
    }),
  }));
  await page.route("**/upload/artifacts", async (route) => {
    const requestBody = route.request().postData() ?? "";
    onUpload?.(requestBody);
    const extraction = {
      status: "unavailable",
      reason: "No agent-readable PDF source was supplied.",
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        protocol_version: 1,
        share_url: new URL(`/a/${shareToken}`, previewUrl).href,
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
          pdf_trust: { status: "human_only", reason: "provenance_missing" },
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
  test("restores a homepage document after sign-in without publishing it", async ({ page }) => {
    let uploadCount = 0;
    await mockUploadService(page, () => {
      uploadCount += 1;
    });
    await page.goto(new URL("/", previewUrl).href);
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("artifactpass-pending-upload", 1);
        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains("uploads")) {
            request.result.createObjectStore("uploads", { keyPath: "key" });
          }
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("uploads", "readwrite");
        transaction.objectStore("uploads").put({
          key: "homepage",
          version: 1,
          name: "handoff.md",
          type: "text/markdown",
          lastModified: Date.now(),
          bytes: new TextEncoder().encode("# Handoff\n\nExact source.").buffer,
          expiresInSeconds: 1800,
          createdAt: Date.now(),
        });
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("error", () => reject(transaction.error));
      });
      database.close();
    });
    await page.evaluate(() => sessionStorage.setItem("artifactpass-pending-upload", "1"));

    await page.goto(uploadUrl);
    await expect(page.getByText("handoff.md")).toBeVisible();
    await expect(page.getByText("Drop one artifact here")).toBeHidden();
    await expect(page.getByText("Selected document")).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace document" })).toBeVisible();
    await expect(page.getByText("Signed in. Review the document and expiry, then create the link.")).toBeVisible();
    await expect(page.getByLabel("Link expires after")).toHaveValue("1800");
    await page.screenshot({ path: "test-results/u4-upload-restored.png", fullPage: true });
    expect(uploadCount).toBe(0);
  });

  test("renders the desktop and mobile upload surface", async ({ page }) => {
    await mockUploadService(page);
    await page.goto(uploadUrl);
    await expect(page.getByRole("heading", { name: /Share the work/ })).toBeVisible();
    await expect(page.getByText("Drop one artifact here")).toBeVisible();
    await expect(page.getByRole("link", { name: "View ArtifactPass on GitHub" })).toBeVisible();
    await page.screenshot({ path: "test-results/u4-upload-desktop.png", fullPage: true });

    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({ path: "test-results/u4-upload-light.png", fullPage: true });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/u4-upload-mobile.png", fullPage: true });
  });

  test("uploads a born-digital browser PDF without exposing extracted agent text", async ({ page }) => {
    let multipartBody = "";
    await mockUploadService(page, (body) => {
      multipartBody = body;
    });
    await page.goto(uploadUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "browser-report.pdf",
      mimeType: "application/pdf",
      buffer: createTextPdf("Born digital report"),
    });
    await page.getByRole("button", { name: "Create temporary link" }).click();
    await expect(page.getByRole("heading", { name: "The link is live." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("browser-report.pdf")).toBeHidden();
    await expect(page.getByRole("button", { name: "Share another document" })).toBeVisible();
    await page.screenshot({ path: "test-results/u4-upload-success.png", fullPage: true });
    expect(multipartBody).toContain("Born digital report");
    expect(multipartBody).not.toContain('name="derived_text"');
    expect(multipartBody).not.toContain('name="pdf_provenance"');
    expect(multipartBody).not.toContain('name="extraction_status"');

    await page.getByRole("button", { name: "Share another document" }).click();
    await expect(page.getByText("Drop one artifact here")).toBeVisible();
  });

  test("uploads an image-only browser PDF through the same human-only path", async ({ page }) => {
    let multipartBody = "";
    await mockUploadService(page, (body) => {
      multipartBody = body;
    });
    await page.goto(uploadUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "image-only-report.pdf",
      mimeType: "application/pdf",
      buffer: createTextPdf(null),
    });
    await page.getByRole("button", { name: "Create temporary link" }).click();
    await expect(page.getByRole("heading", { name: "The link is live." })).toBeVisible({ timeout: 20_000 });
    expect(multipartBody).not.toContain('name="derived_text"');
    expect(multipartBody).not.toContain('name="pdf_provenance"');
    expect(multipartBody).not.toContain('name="extraction_status"');
  });

  test("preserves the selected document and returns to sign-in when the session expires", async ({ page }) => {
    let authenticated = true;
    await mockUploadService(page, undefined, () => authenticated);
    await page.route("**/auth/sign-in?**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<h1>Sign in again</h1>",
    }));
    await page.goto(uploadUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "session-expiry.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Preserve this handoff"),
    });

    authenticated = false;
    await page.getByRole("button", { name: "Create temporary link" }).click();
    await page.waitForURL(/\/auth\/sign-in\?/u);
    await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
      sessionStorage.getItem("artifactpass-pending-upload"),
    )).toBe("1");
  });
});
