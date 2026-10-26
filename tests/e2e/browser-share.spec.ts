import { expect, test } from "@playwright/test";

const configured =
  process.env.ARTIFACT_SHARE_E2E_BASE_URL !== undefined &&
  process.env.ARTIFACT_SHARE_E2E_STORAGE_STATE !== undefined;
const liveRun = process.env.npm_lifecycle_event === "test:browser:live";

const createTextPdf = (text: string): Buffer => {
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

test.describe("authenticated browser sharing", () => {
  test.skip(
    !configured && !liveRun,
    "Set a real Access-protected URL and external Playwright storage state; see docs/operations.md.",
  );
  test.beforeAll(() => {
    if (!configured) {
      throw new Error("Live browser sharing requires ARTIFACT_SHARE_E2E_BASE_URL and ARTIFACT_SHARE_E2E_STORAGE_STATE; it must not silently skip.");
    }
  });

  test("uploads Markdown, copies its URL, and opens the public safe viewer", async ({
    context,
    page,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/upload");

    await page.locator('input[type="file"]').setInputFiles({
      name: "browser-handoff.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Browser handoff\n\nExact source from the authenticated page.\n"),
    });
    await page.getByRole("radio", { name: "1 hour" }).check();
    await page.getByRole("button", { name: "Create temporary link" }).click();

    const shareField = page.getByLabel("Share URL");
    await expect(shareField).toHaveValue(/\/a\/[A-Za-z0-9_-]{43}$/u);
    const shareUrl = await shareField.inputValue();
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);

    await page.goto(shareUrl);
    await expect(page.getByRole("heading", { name: "Browser handoff" })).toBeVisible();
    await expect(page.getByText("Exact source from the authenticated page.")).toBeVisible();
    const raw = await page.request.get(`${shareUrl}/raw`);
    expect(await raw.text()).toBe("# Browser handoff\n\nExact source from the authenticated page.\n");
  });

  test("renders uploaded HTML in the initial sandboxed preview without making an external request", async ({ page }) => {
    const leakedRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://leak.example")) leakedRequests.push(request.url());
    });
    await page.goto("/upload");
    await page.locator('input[type="file"]').setInputFiles({
      name: "hostile.html",
      mimeType: "text/html",
      buffer: Buffer.from(
        '<h1>Readable</h1><script>parent.document.body.dataset.pwned="yes"</script><img src="https://leak.example/pixel">',
      ),
    });
    await page.getByRole("radio", { name: "1 day" }).check();
    await page.getByRole("button", { name: "Create temporary link" }).click();
    const shareField = page.getByLabel("Share URL");
    await expect(shareField).toHaveValue(/\/a\/[A-Za-z0-9_-]{43}$/u);
    const shareUrl = await shareField.inputValue();
    await page.goto(shareUrl);

    const frame = page.locator('iframe[title="HTML page preview"]');
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("src", `${new URL(shareUrl).pathname}/preview`);
    // An iframe element and a working /preview response are not enough: the
    // initial viewer must actually show the uploaded document without a toggle.
    await expect(page.frameLocator('iframe[title="HTML page preview"]').getByRole("heading", { name: "Readable" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("body")).not.toHaveAttribute("data-pwned", "yes");
    expect(leakedRequests).toEqual([]);

    await page.getByRole("tab", { name: "Source" }).click();
    await expect(page.locator(".artifact-source--html")).toContainText('parent.document.body.dataset.pwned="yes"');
    const raw = await page.request.get(`${shareUrl}/raw`);
    expect(await raw.text()).toBe('<h1>Readable</h1><script>parent.document.body.dataset.pwned="yes"</script><img src="https://leak.example/pixel">');
  });

  test("renders static HTML on first open without requiring an interaction", async ({ page }) => {
    await page.goto("/upload");
    await page.locator('input[type="file"]').setInputFiles({
      name: "static.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><html><body><h1>Static preview is visible</h1></body></html>"),
    });
    await page.getByRole("button", { name: "Create temporary link" }).click();
    const shareField = page.getByLabel("Share URL");
    await expect(shareField).toHaveValue(/\/a\/[A-Za-z0-9_-]{43}$/u);
    await page.goto(await shareField.inputValue());

    await expect(page.frameLocator('iframe[title="HTML page preview"]').getByRole("heading", { name: "Static preview is visible" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Enable JavaScript" })).toHaveCount(0);
  });

  test("keeps PDF preview, range reads, and exact download distinct", async ({ page }) => {
    const source = createTextPdf("Live browser PDF fixture");
    await page.goto("/upload");
    await page.locator('input[type="file"]').setInputFiles({
      name: "browser-report.pdf",
      mimeType: "application/pdf",
      buffer: source,
    });
    await page.getByRole("button", { name: "Create temporary link" }).click();
    const shareUrl = await page.getByLabel("Share URL").inputValue();
    await page.goto(shareUrl);

    await expect(page.locator('iframe[title="PDF document"]')).toHaveAttribute(
      "src",
      `${new URL(shareUrl).pathname}/content`,
    );
    const range = await page.request.get(`${shareUrl}/content`, {
      headers: { range: "bytes=5-9" },
    });
    expect(range.status()).toBe(206);
    expect(range.headers()["content-disposition"]).toContain("inline");
    expect(await range.body()).toEqual(source.subarray(5, 10));
    const download = await page.request.get(`${shareUrl}/raw`);
    expect(download.headers()["content-disposition"]).toContain("attachment");
    expect(await download.body()).toEqual(source);
  });

  test("has no dashboard, history, or settings surface", async ({ request }) => {
    for (const path of ["/dashboard", "/history", "/settings"]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });
});
