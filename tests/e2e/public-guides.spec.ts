import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const guideRoutes = [
  "/guides",
  "/guides/agent-setup",
  "/guides/private-deployment",
  "/guides/private-teammate",
] as const;

const commandButton = (page: Page) => page.locator(".guide-command").filter({
  has: page.locator("[data-guide-command]", { hasText: /^pnpm dlx /u }),
}).locator("[data-copy-command]").first();

const readMatchingFiles = async (directory: string): Promise<string[]> => {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      values.push(...await readMatchingFiles(path));
    } else if (/\.(?:html|svg)$/u.test(entry.name)) {
      values.push(await readFile(path, "utf8"));
    }
  }
  return values;
};

test("serves every clean guide route from built output under the generated CSP", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to/iu.test(message.text())) {
      cspErrors.push(message.text());
    }
  });

  for (const route of guideRoutes) {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(route);
    expect(response?.headers()["content-security-policy"]).toMatch(/script-src[^;]*'sha256-/u);
    await expect(page.locator("body > .shell")).toBeVisible();
  }

  expect(cspErrors).toEqual([]);
});

test("keyboard copy succeeds, announces, retains focus, and resets", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { (window as any).__copiedCommand = value; } },
    });
  });
  await page.goto("/guides/agent-setup");
  const button = commandButton(page);
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(button).toHaveText("Copied");
  await expect(button).toBeFocused();
  await expect(button.locator("xpath=following-sibling::*[@data-copy-status]")).toHaveText("Command copied.");
  await expect.poll(() => page.evaluate(() => (window as any).__copiedCommand)).toMatch(/^pnpm dlx /u);
  await expect(button).toHaveText("Copy", { timeout: 3_000 });
  await expect(button.locator("xpath=following-sibling::*[@data-copy-status]")).toHaveText("");
});

test("Clipboard rejection selects the exact command and announces the fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("clipboard denied")) },
    });
  });
  await page.goto("/guides/private-deployment");
  const button = commandButton(page);
  const command = button.locator("xpath=preceding-sibling::*[@data-guide-command]");
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(button).toHaveText("Selected");
  await expect(button).toBeFocused();
  await expect(button.locator("xpath=following-sibling::*[@data-copy-status]")).toHaveText(
    "Copy unavailable. Command selected for manual copying.",
  );
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(await command.textContent());
});

test("serializes overlapping Clipboard activations", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__clipboardCalls = [];
    (window as any).__clipboardResolvers = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          (window as any).__clipboardCalls.push(value);
          return new Promise<void>((resolvePromise) => {
            (window as any).__clipboardResolvers.push(resolvePromise);
          });
        },
      },
    });
  });
  await page.goto("/guides/private-teammate");
  const button = commandButton(page);
  await button.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => (window as any).__clipboardCalls.length)).toBe(1);
  await page.evaluate(() => (window as any).__clipboardResolvers.shift()());
  await expect(button).toHaveText("Copied");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__clipboardCalls.length)).toBe(2);
  await page.evaluate(() => (window as any).__clipboardResolvers.shift()());
  await expect(button).toHaveText("Copied");
  await expect(button).toBeFocused();
});

test("uses only approved documentation namespaces in guides and generated assets", async ({ page }) => {
  const approvedDomains = new Set([
    "artifactpass.com",
    "cloudflare.com",
    "cloudflareinsights.com",
    "example.com",
    "example.net",
    "github.com",
    "schema.org",
    "sitemaps.org",
    "w3.org",
  ]);
  const domainPattern = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org)\b/giu;
  const emailPattern = /[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+(?:com|net|org)\b/giu;
  const values: string[] = [];

  for (const route of guideRoutes) {
    await page.goto(route);
    values.push(await page.locator("html").innerHTML());
  }

  for (const directory of [
    "apps/artifact-service/public/guides/agent-setup",
    "apps/artifact-service/public/guides/private-deployment",
    "apps/artifact-service/public/guides/private-teammate",
    "apps/artifact-pages/dist/guides",
  ]) {
    values.push(...await readMatchingFiles(resolve(directory)));
  }
  values.push(await readFile(resolve("apps/artifact-pages/dist/guides.html"), "utf8"));

  const foundEmails = values.flatMap((value) => value.match(emailPattern) ?? []);
  expect(foundEmails.every((email) => /@(example\.com|example\.net)$/iu.test(email))).toBe(true);

  const foundDomains = values.flatMap((value) => value.match(domainPattern) ?? []).map((value) => {
    const withoutProtocol = value.replace(/^https?:\/\//iu, "");
    return withoutProtocol.toLowerCase();
  });
  const unexpectedDomains = foundDomains.filter((domain) =>
    ![...approvedDomains].some((approved) => domain === approved || domain.endsWith(`.${approved}`))
  );
  expect(unexpectedDomains).toEqual([]);
});
