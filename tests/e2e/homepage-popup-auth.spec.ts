import { expect, test } from "@playwright/test";

import { homepageInteractionScript, publicStyles } from "../../apps/artifact-service/src/web/routes/public-homepage";

const origin = "http://artifactpass.test";
const homepage = `<!doctype html><html data-theme="light"><body>
  <code id="install-command">pnpm dlx artifactpass</code><button id="copy-command">Copy</button>
  <button id="open-upload">Try it with your own document</button>
  <div id="drop-overlay"><strong>Drop to preview</strong><span>Nothing uploads yet.</span></div>
  <dialog id="upload-dialog">
    <p id="upload-description">Choose one document to create a temporary link.</p>
    <button id="close-upload">Close</button>
    <input id="pending-file-input" type="file">
    <div id="drop-zone" tabindex="0"><strong>Drop a document here</strong><span>Choose a file</span></div>
    <div id="file-preview" hidden><b id="file-kind">FILE</b><strong id="file-name"></strong><span id="file-details"></span><button id="change-file">Choose another</button></div>
    <p id="local-note" hidden>Kept in this browser only.</p><p id="upload-status" hidden></p><div id="upload-config" hidden></div>
    <input type="radio" name="expiry" value="900" checked>
    <button id="continue-upload">Continue to sign in</button>
  </dialog>
  <script>${homepageInteractionScript}</script>
</body></html>`;

const visualHomepage = `<!doctype html><html data-theme="light"><head><style>${publicStyles}</style></head><body>
  <div class="shell"><main class="homepage-main"><section class="hero"><div class="hero-copy">
    <code id="install-command">pnpm dlx artifactpass</code><button id="copy-command">Copy</button>
    <button class="try-card" id="open-upload"><strong>Try it with your own document</strong><small>Click to preview.</small><span>MD, HTML, PDF</span></button>
  </div></section></main></div>
  <div class="drop-overlay" id="drop-overlay"><div><strong>Drop to preview</strong><span>Nothing uploads yet.</span></div></div>
  <dialog id="upload-dialog" aria-labelledby="upload-title" aria-describedby="upload-description">
    <div class="dialog-header"><div><h2 id="upload-title">Try ArtifactPass</h2><p id="upload-description">Choose one document to create a temporary link.</p></div><button class="close-dialog" id="close-upload" aria-label="Close upload preview">×</button></div>
    <div class="dialog-body"><input id="pending-file-input" type="file" hidden>
      <div class="drop-zone" id="drop-zone" tabindex="0"><div><strong>Drop a document here</strong><span>Choose a file</span></div></div>
      <div class="file-preview" id="file-preview" hidden><b class="file-kind" id="file-kind">FILE</b><strong id="file-name"></strong><span id="file-details"></span><button id="change-file">Choose another</button></div>
      <p class="local-note" id="local-note" hidden>Kept in this browser only. Nothing uploads before sign-in and final confirmation.</p><p class="modal-status" id="upload-status" hidden></p>
      <div class="upload-config" id="upload-config" hidden><fieldset><legend>How long should the link work?</legend><div class="expiry-options"><label><input type="radio" name="expiry" value="900" checked><span>15 min</span></label><label><input type="radio" name="expiry" value="1800"><span>30 min</span></label><label><input type="radio" name="expiry" value="3600"><span>60 min</span></label></div></fieldset><div class="auth-gate"><p>Sign in in a popup. This page stays open, and you still approve the upload before a link is created.</p><button class="continue-button" id="continue-upload">Continue to sign in</button></div></div>
    </div>
  </dialog><script>${homepageInteractionScript}</script>
</body></html>`;

const responsiveHomepage = `<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${publicStyles}</style></head><body>
  <div class="shell"><main class="homepage-main"><section class="hero"><div class="hero-copy">
    <h1>Pass work between agents.</h1><p class="subhead">Exact, temporary artifact handoffs for developers and agentic teams.</p>
    <section class="setup"><div class="command"><code>pnpm dlx artifactpass@rc --base-url https://staging.artifactpass.com</code><button class="copy-button">Copy</button></div></section>
  </div><section class="handoff-stage" aria-label="ArtifactPass handoff example"><div class="flow"><article class="agent-panel">Codex</article><div class="relay">ArtifactPass link</div><article class="agent-panel">Claude Code</article></div></section></section>
  <section class="trust"><div class="cloudflare">Cloudflare-native</div><div class="trust-links"><div class="trust-item">Short-lived</div></div></section>
  </main></div>
</body></html>`;

test("renders a single selected document without the empty drop target", async ({ context, page }) => {
  await context.route(`${origin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: visualHomepage,
  }));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?theme=light`);
  await page.getByRole("button", { name: /Try it with your own document/ }).click();
  await page.locator("#pending-file-input").setInputFiles({
    name: "handoff.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Exact handoff"),
  });

  await expect(page.locator("#drop-zone")).toBeHidden();
  await expect(page.getByText("handoff.md")).toBeVisible();
  await page.screenshot({ path: "test-results/homepage-selected-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/homepage-selected-mobile.png", fullPage: true });
});

test("keeps the complete landing page inside phone and tablet viewports", async ({ context, page }) => {
  await context.route(`${origin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: responsiveHomepage,
  }));

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/?theme=light`);

    const dimensions = await page.locator("html").evaluate((root) => ({
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    }));

    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    await expect(page.getByRole("heading", { name: "Pass work between agents." })).toBeVisible();
    await expect(page.getByRole("region", { name: "ArtifactPass handoff example" })).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/homepage-responsive-mobile.png", fullPage: true });
});

test("keeps the landing page open while authentication runs in a popup", async ({ context, page }) => {
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: homepage });
      return;
    }
    if (url.pathname === "/auth/sign-in") {
      await route.fulfill({ contentType: "text/html", body: "<h1>Sign in to ArtifactPass</h1>" });
      return;
    }
    if (url.pathname === "/auth/popup/complete") {
      await route.fulfill({
        contentType: "text/html",
        body: `<script>window.opener.postMessage({type:"artifactpass:auth-complete"},window.location.origin);window.close();</script>`,
      });
      return;
    }
    if (url.pathname === "/upload") {
      await route.fulfill({ contentType: "text/html", body: "<h1>Upload restored</h1>" });
      return;
    }
    await route.abort();
  });

  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: /Try it with your own document/ }).click();
  await page.locator("#pending-file-input").setInputFiles({
    name: "handoff.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Popup handoff"),
  });

  await expect(page.locator("#drop-zone")).toBeHidden();
  await expect(page.locator("#file-preview")).toBeVisible();
  await expect(page.getByText("handoff.md")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose another" })).toBeVisible();
  await expect(page.locator("#upload-description")).toHaveText("One document selected. Nothing uploads until you confirm.");
  await expect(page.locator("#local-note")).toHaveText("Kept in this browser only.");

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continue to sign in" }).click();
  const popup = await popupPromise;
  await popup.waitForURL(`${origin}/auth/sign-in?return_to=%2Fauth%2Fpopup%2Fcomplete%3Ftheme%3Dlight&theme=light`);

  expect(page.url()).toBe(`${origin}/`);
  await expect(page.locator("#upload-dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Choose another" })).toBeDisabled();
  await expect(page.locator('input[name="expiry"]')).toBeDisabled();
  await expect(page.locator("#upload-status")).toHaveText("Finish signing in in the popup. This page will continue automatically.");
  await expect(popup.getByRole("heading", { name: "Sign in to ArtifactPass" })).toBeVisible();

  const completion = popup.goto(`${origin}/auth/popup/complete?theme=light`).catch(() => null);
  await page.waitForURL(`${origin}/upload`);
  await completion;
  await expect(page.getByRole("heading", { name: "Upload restored" })).toBeVisible();
});

test("keeps one selected document ready when the sign-in popup is closed", async ({ context, page }) => {
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: homepage });
      return;
    }
    if (url.pathname === "/auth/sign-in") {
      await route.fulfill({ contentType: "text/html", body: "<h1>Sign in to ArtifactPass</h1>" });
      return;
    }
    await route.abort();
  });

  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: /Try it with your own document/ }).click();
  await page.locator("#pending-file-input").setInputFiles({
    name: "handoff.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Popup handoff"),
  });

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continue to sign in" }).click();
  const popup = await popupPromise;
  await popup.waitForURL(`${origin}/auth/sign-in?return_to=%2Fauth%2Fpopup%2Fcomplete%3Ftheme%3Dlight&theme=light`);
  await popup.close();

  await expect(page.locator("#upload-status")).toHaveText("Sign-in was closed. Your document is still selected.");
  await expect(page.getByText("handoff.md")).toBeVisible();
  await expect(page.locator("#drop-zone")).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue to sign in" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Choose another" })).toBeEnabled();
  await expect(page.locator("#local-note")).toHaveText("Kept in this browser only.");
});
