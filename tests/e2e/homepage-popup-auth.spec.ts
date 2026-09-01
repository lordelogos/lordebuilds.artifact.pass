import { expect, test } from "@playwright/test";

import { popupCancelledScript } from "../../apps/artifact-service/src/web/popup-cancel";
import { popupCompleteScript } from "../../apps/artifact-service/src/web/popup-complete";
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
    <input type="radio" name="expiry" value="1800">
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

test("keeps mobile authentication in one tab with the selected document stored", async ({ context, page }) => {
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
    if (url.pathname === "/upload") {
      await route.fulfill({
        contentType: "text/html",
        body: `<p id="restored"></p><script>(async()=>{const request=indexedDB.open("artifactpass-pending-upload",1);request.onsuccess=()=>{const db=request.result;const read=db.transaction("uploads","readonly").objectStore("uploads").get("homepage");read.onsuccess=()=>{const record=read.result;document.querySelector("#restored").textContent=record.name+"|"+record.expiresInSeconds+"|"+new TextDecoder().decode(record.bytes);db.close();};};})();</script>`,
      });
      return;
    }
    await route.abort();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: /Try it with your own document/ }).click();
  await page.locator("#pending-file-input").setInputFiles({
    name: "mobile-handoff.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Mobile handoff"),
  });
  await page.locator('input[name="expiry"][value="1800"]').check();

  await page.getByRole("button", { name: "Continue to sign in" }).click();
  await page.waitForURL(new RegExp(`${origin}/auth/sign-in\\?`));

  expect(context.pages()).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get("return_to")).toBe("/upload?pending=homepage");
  expect(await page.evaluate(() => sessionStorage.getItem("artifactpass-pending-upload"))).toBe("1");
  expect(await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("artifactpass-pending-upload", 1);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const record = await new Promise<{
      name?: string;
      type?: string;
      bytes?: ArrayBuffer;
      expiresInSeconds?: number;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("uploads", "readonly");
      const request = transaction.objectStore("uploads").get("homepage");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    database.close();
    return {
      name: record?.name,
      type: record?.type,
      contents: record?.bytes instanceof ArrayBuffer ? new TextDecoder().decode(record.bytes) : undefined,
      expiresInSeconds: record?.expiresInSeconds,
    };
  })).toEqual({
    name: "mobile-handoff.md",
    type: "text/markdown",
    contents: "# Mobile handoff",
    expiresInSeconds: 1800,
  });

  await page.goto(`${origin}/upload`);
  expect(context.pages()).toHaveLength(1);
  await expect(page.locator("#restored")).toHaveText("mobile-handoff.md|1800|# Mobile handoff");
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
        body: `<p id="popup-status"></p><a id="completion-fallback" href="/upload" hidden>Continue in this tab</a><script>${popupCompleteScript}</script>`,
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
  await popup.waitForURL(new RegExp(`${origin}/auth/sign-in\\?return_to=.*flow.*&theme=light`));

  expect(page.url()).toBe(`${origin}/`);
  await expect(page.locator("#upload-dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Choose another" })).toBeDisabled();
  await expect(page.locator('input[name="expiry"]')).toHaveCount(2);
  await expect(page.locator('input[name="expiry"]').first()).toBeDisabled();
  await expect(page.locator('input[name="expiry"]').nth(1)).toBeDisabled();
  await expect(page.locator("#upload-status")).toHaveText("Finish signing in in the popup. This page will continue automatically.");
  await expect(popup.getByRole("heading", { name: "Sign in to ArtifactPass" })).toBeVisible();

  const returnTo = new URL(popup.url()).searchParams.get("return_to");
  expect(returnTo).not.toBeNull();
  const completion = popup.goto(new URL(returnTo ?? "", origin).href).catch(() => null);
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
  await popup.waitForURL(new RegExp(`${origin}/auth/sign-in\\?return_to=.*flow.*&theme=light`));
  await popup.close();

  await expect(page.locator("#upload-status")).toHaveText("Sign-in was closed. Your document is still selected.");
  await expect(page.getByText("handoff.md")).toBeVisible();
  await expect(page.locator("#drop-zone")).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue to sign in" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Choose another" })).toBeEnabled();
  await expect(page.locator("#local-note")).toHaveText("Kept in this browser only.");
});

test("accepts a matching completion signal after the popup closes", async ({ context, page }) => {
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
    buffer: Buffer.from("# Delayed completion"),
  });

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continue to sign in" }).click();
  const popup = await popupPromise;
  await popup.waitForURL(new RegExp(`${origin}/auth/sign-in\\?return_to=.*flow.*&theme=light`));
  const returnTo = new URL(popup.url()).searchParams.get("return_to");
  const flow = new URL(returnTo ?? "", origin).searchParams.get("flow");
  await popup.close();
  await page.waitForTimeout(550);
  await page.evaluate((matchingFlow) => {
    const channel = new BroadcastChannel("artifactpass-auth");
    channel.postMessage({ type: "artifactpass:auth-complete", flow: matchingFlow });
    channel.close();
  }, flow);

  await page.waitForURL(`${origin}/upload`);
  await expect(page.getByRole("heading", { name: "Upload restored" })).toBeVisible();
});

test("restores the stored document from a completion tab without an opener", async ({ context }) => {
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: homepage });
      return;
    }
    if (url.pathname === "/auth/popup/complete") {
      await route.fulfill({
        contentType: "text/html",
        body: `<p id="popup-status"></p><a id="completion-fallback" href="/upload" hidden>Continue in this tab</a><script>${popupCompleteScript}</script>`,
      });
      return;
    }
    if (url.pathname === "/upload") {
      await route.fulfill({
        contentType: "text/html",
        body: `<p id="restored"></p><script>(async()=>{const request=indexedDB.open("artifactpass-pending-upload",1);request.onsuccess=()=>{const db=request.result;const read=db.transaction("uploads","readonly").objectStore("uploads").get("homepage");read.onsuccess=()=>{const record=read.result;document.querySelector("#restored").textContent=record.name+"|"+record.expiresInSeconds+"|"+new TextDecoder().decode(record.bytes);db.close();};};})();</script>`,
      });
      return;
    }
    await route.abort();
  });

  const authTab = await context.newPage();
  await authTab.goto(`${origin}/`);
  await authTab.evaluate(async () => {
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
        name: "orphaned-popup.md",
        type: "text/markdown",
        lastModified: Date.now(),
        bytes: new TextEncoder().encode("# Orphaned popup").buffer,
        expiresInSeconds: 1800,
        createdAt: Date.now(),
      });
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    database.close();
  });

  await authTab.goto(`${origin}/auth/popup/complete?flow=11111111222233334444555555555555`);
  await expect(authTab.getByRole("link", { name: "Continue in this tab" })).toBeVisible();
  expect(await authTab.evaluate(() => sessionStorage.getItem("artifactpass-pending-upload"))).toBe("1");
  await authTab.getByRole("link", { name: "Continue in this tab" }).click();
  await expect(authTab.locator("#restored")).toHaveText("orphaned-popup.md|1800|# Orphaned popup");
});

test("returns a cancelled provider sign-in to the selected document", async ({ context, page }) => {
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
    if (url.pathname === "/auth/popup/cancel") {
      await route.fulfill({
        contentType: "text/html",
        body: `<button id="return-to-app">Return to ArtifactPass</button><p id="popup-status"></p><script>${popupCancelledScript}</script>`,
      });
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
  await popup.waitForURL(new RegExp(`${origin}/auth/sign-in\\?return_to=.*flow.*&theme=light`));
  const returnTo = new URL(popup.url()).searchParams.get("return_to");
  expect(returnTo).not.toBeNull();
  const flow = new URL(returnTo ?? "", origin).searchParams.get("flow");
  expect(flow).toMatch(/^[0-9a-f]{32}$/u);
  await page.evaluate(() => {
    const channel = new BroadcastChannel("artifactpass-auth");
    channel.postMessage({ type: "artifactpass:auth-cancelled", flow: "unrelated-flow" });
    channel.close();
  });
  await expect(page.getByRole("button", { name: "Finish sign-in in the popup" })).toBeDisabled();
  await popup.goto(`${origin}/auth/popup/cancel?theme=light&flow=${flow ?? ""}`).catch(() => null);

  await expect(page.locator("#upload-status")).toHaveText("Sign-in cancelled. Your document is still selected.");
  await expect(page.getByText("handoff.md")).toBeVisible();
  await expect(page.locator("#drop-zone")).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue to sign in" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Choose another" })).toBeEnabled();
  await expect(page.locator('input[name="expiry"]')).toHaveCount(2);
  await expect(page.locator('input[name="expiry"]').first()).toBeEnabled();
  await expect(page.locator('input[name="expiry"]').nth(1)).toBeEnabled();
});

test("falls back to the upload screen when a mobile auth tab cannot close", async ({ context }) => {
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: homepage });
      return;
    }
    if (url.pathname === "/auth/popup/cancel") {
      await route.fulfill({
        contentType: "text/html",
        body: `<button id="return-to-app">Return to ArtifactPass</button><script>${popupCancelledScript}</script>`,
      });
      return;
    }
    await route.abort();
  });

  const authTab = await context.newPage();
  await authTab.goto(`${origin}/`);
  await authTab.evaluate(async () => {
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
        name: "mobile-handoff.md",
        type: "text/markdown",
        lastModified: Date.now(),
        bytes: new TextEncoder().encode("# Mobile handoff").buffer,
        expiresInSeconds: 1800,
        createdAt: Date.now(),
      });
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    database.close();
  });
  await authTab.goto(`${origin}/auth/popup/cancel?theme=light&flow=11111111222233334444555555555555`);
  await authTab.waitForURL(`${origin}/?upload=1&auth=cancelled`);
  await expect(authTab.getByText("mobile-handoff.md")).toBeVisible();
  await expect(authTab.locator("#upload-status")).toHaveText("Sign-in cancelled. Your document is still selected.");
  await expect(authTab.locator('input[name="expiry"][value="1800"]')).toBeChecked();
  await expect(authTab.getByRole("button", { name: "Continue to sign in" })).toBeEnabled();
});
