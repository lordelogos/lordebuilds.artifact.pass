import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArtifactManifest } from "artifact-protocol";

import { renderSafeHtmlPreview } from "../../apps/artifact-service/src/web/viewers/content-sanitizer";
import {
  HTML_INTERACTIVE_CONTENT_SECURITY_POLICY,
  HTML_PREVIEW_CONTENT_SECURITY_POLICY,
} from "../../apps/artifact-service/src/web/viewers/html-preview-policy";

const origin = process.env.ARTIFACT_SHARE_PREVIEW_URL ?? "http://127.0.0.1:4173";
const sharePath = "/interactive-artifact";
const viewerUrl = new URL(sharePath, origin).href;
const previewUrl = new URL(`${sharePath}/preview`, origin).href;
const interactiveUrl = new URL(`${sharePath}/interactive`, origin).href;
const leakOrigin = "https://leak.artifactpass.test";

let vite: { close: () => Promise<void>; ssrLoadModule: (path: string) => Promise<unknown> };
let renderSharePage: typeof import("../../apps/artifact-service/src/web/routes/share-page").renderSharePage;

test.beforeAll(async () => {
  const appRequire = createRequire(new URL("../../apps/artifact-service/package.json", import.meta.url));
  const { createServer } = await import(pathToFileURL(appRequire.resolve("vite")).href);
  vite = await createServer({
    root: fileURLToPath(new URL("../../apps/artifact-service", import.meta.url)),
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ renderSharePage } = await vite.ssrLoadModule("/src/web/routes/share-page.tsx") as {
    renderSharePage: typeof renderSharePage;
  });
});

test.afterAll(async () => {
  await vite.close();
});

const source = `<!doctype html>
<html lang="en">
  <body>
    <button id="counter" type="button">Count 0</button>
    <script>
      let count = 0;
      document.querySelector("#counter").addEventListener("click", event => {
        count += 1;
        event.currentTarget.textContent = "Count " + count;
      });
      try {
        parent.document.body.dataset.compromised = "true";
      } catch {
        document.body.dataset.parentBlocked = "true";
      }
      fetch("${leakOrigin}/blocked").catch(() => {
        document.body.dataset.networkBlocked = "true";
      });
    </script>
  </body>
</html>`;

const manifest: ArtifactManifest = {
  protocol_version: 1,
  artifact_id: "018f47a2-93c6-7fd0-9d0f-80b9ac47f005",
  filename: "interactive-demo.html",
  mime_type: "text/html",
  byte_size: new TextEncoder().encode(source).byteLength,
  sha256: "a".repeat(64),
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  extraction: { status: "not_applicable" },
  pdf_trust: { status: "not_applicable" },
};

test("interactive HTML requires consent, stays isolated, and resets when disabled", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(leakOrigin)) externalRequests.push(request.url());
  });

  await page.route(viewerUrl, (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: renderSharePage({
      manifest,
      nonce: "interactive-preview-test",
      representation: {
        kind: "html",
        interactiveUrl: `${sharePath}/interactive`,
        previewUrl: `${sharePath}/preview`,
        source,
      },
      sharePath,
    }),
  }));
  await page.route(previewUrl, (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: { "Content-Security-Policy": HTML_PREVIEW_CONTENT_SECURITY_POLICY },
    body: renderSafeHtmlPreview(source),
  }));
  await page.route(interactiveUrl, (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: { "Content-Security-Policy": HTML_INTERACTIVE_CONTENT_SECURITY_POLICY },
    body: source,
  }));

  await page.goto(viewerUrl);
  const frame = page.frameLocator('iframe[title="HTML page preview"]');
  const frameElement = page.locator('iframe[title="HTML page preview"]');
  const zoomControls = page.getByRole("group", { name: "HTML preview zoom" });

  await expect(page.getByText("This file contains JavaScript", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Count 0" })).toBeDisabled();
  await expect(frameElement).toHaveAttribute("sandbox", "");
  await expect(zoomControls).toBeHidden();
  await page.getByRole("button", { name: "Show zoom controls" }).click();
  await expect(zoomControls).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(zoomControls).toBeHidden();

  await page.getByRole("button", { name: "Enable JavaScript" }).click();
  await expect(page.getByRole("button", { name: "Disable JavaScript" })).toBeVisible();
  await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame.locator("body")).toHaveAttribute("data-parent-blocked", "true");
  await expect(frame.locator("body")).toHaveAttribute("data-network-blocked", "true");
  expect(await page.locator("body").getAttribute("data-compromised")).toBeNull();
  expect(externalRequests).toEqual([]);

  await frame.getByRole("button", { name: "Count 0" }).click();
  await expect(frame.getByRole("button", { name: "Count 1" })).toBeVisible();
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator("#viewer-panel-source")).toBeVisible();
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(frame.getByRole("button", { name: "Count 1" })).toBeVisible();

  await page.getByRole("button", { name: "Disable JavaScript" }).click();
  await expect(page.getByRole("button", { name: "Enable JavaScript" })).toBeVisible();
  await expect(frameElement).toHaveAttribute("sandbox", "");
  await expect(frame.getByRole("button", { name: "Count 0" })).toBeDisabled();
});
