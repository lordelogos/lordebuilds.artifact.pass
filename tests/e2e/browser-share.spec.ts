import { expect, test } from "@playwright/test";

const configured =
  process.env.ARTIFACT_SHARE_E2E_BASE_URL !== undefined &&
  process.env.ARTIFACT_SHARE_E2E_STORAGE_STATE !== undefined;

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
    !configured,
    "Set a real Access-protected dev URL and external Playwright storage state; see browser-testing.md.",
  );

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
    await page.getByRole("radio", { name: "30 minutes" }).check();
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

  test("contains hostile HTML in a no-permission sandbox and makes no external request", async ({ page }) => {
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
    await page.getByRole("button", { name: "Create temporary link" }).click();
    const shareUrl = await page.getByLabel("Share URL").inputValue();
    await page.goto(shareUrl);

    const frame = page.locator('iframe[title="Sanitized HTML preview"]');
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect.poll(() => page.locator("body").getAttribute("data-pwned")).toBeNull();
    expect(leakedRequests).toEqual([]);
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

    await expect(page.locator('iframe[title="PDF preview"]')).toHaveAttribute(
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
