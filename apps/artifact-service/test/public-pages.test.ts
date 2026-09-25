import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createArtifactApplication } from "../src/server/index";
import {
  PUBLIC_SITE_ORIGIN,
  renderRobotsTxt,
  renderSitemapXml,
  renderStaticPublicPage,
} from "../src/web/routes/public-pages";

const requestFrom = (origin: string, path: string): Promise<Response> =>
  Promise.resolve(createArtifactApplication().fetch(
    new Request(`${origin}${path}`),
    env,
  ));

describe("public site", () => {
  it.each([
    ["home", "ArtifactPass", "Pass work between agents, teammates, and humans."],
    ["privacy", "Privacy", "Google and GitHub"],
    ["terms", "Terms", "temporary bearer link"],
  ] as const)("renders the static %s page", (page, title, copy) => {
    const markup = renderStaticPublicPage(page);

    expect(markup).toContain(`<title>${title}`);
    expect(markup).toContain(copy);
    expect(markup).toContain('name="robots" content="index, follow, max-image-preview:large"');
    expect(markup).toContain(`rel="canonical" href="${PUBLIC_SITE_ORIGIN}`);
  });

  it("publishes crawlable metadata and structured product data", () => {
    const markup = renderStaticPublicPage("home");

    expect(markup).toContain('property="og:title"');
    expect(markup).toContain('name="twitter:card" content="summary"');
    expect(markup).toContain('type="application/ld+json"');
    expect(markup).toContain('"@type":"WebSite"');
    expect(markup).toContain('"@type":"SoftwareApplication"');
    expect(renderRobotsTxt(`${PUBLIC_SITE_ORIGIN}/robots.txt`)).toContain("Allow: /");
    expect(renderSitemapXml()).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/</loc>`);
    expect(renderSitemapXml()).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/privacy</loc>`);
    expect(renderSitemapXml()).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/terms</loc>`);
  });

  it("links the public homepage to the app and policy pages", () => {
    const markup = renderStaticPublicPage("home");

    expect(markup).toContain('href="/upload"');
    expect(markup).toContain('href="#how"');
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
  });

  it("explains the product in plain language for people and AI agents", () => {
    const markup = renderStaticPublicPage("home");

    expect(markup).toContain('id="how"');
    expect(markup).toContain("How ArtifactPass works");
    expect(markup).toContain("A temporary link for your work.");
    expect(markup).toContain("Pick a file.");
    expect(markup).toContain("Pick a time.");
    expect(markup).toContain("Send the link.");
    expect(markup).toContain("One agent shares the file.");
    expect(markup).toContain("The next agent opens the exact file.");
    expect(markup).toContain("No copy-pasting. No lost formatting.");
  });

  it("presents the public retention choices", () => {
    const markup = renderStaticPublicPage("home");

    expect(markup).toMatch(/name="expiry"[^>]*value="3600"/u);
    expect(markup).toMatch(/name="expiry"[^>]*value="86400"/u);
    expect(markup).toMatch(/name="expiry"[^>]*value="604800"/u);
    expect(markup).not.toMatch(/name="expiry"[^>]*value="900"/u);
    expect(markup).not.toMatch(/name="expiry"[^>]*value="1800"/u);
  });

  it("uses the stable unpinned setup command", () => {
    const markup = renderStaticPublicPage("home");

    expect(markup).toContain('<code id="install-command">pnpm dlx artifactpass</code>');
    expect(markup).not.toContain("--base-url");
  });

  it("publishes complete service policies", () => {
    const privacy = renderStaticPublicPage("privacy");
    const terms = renderStaticPublicPage("terms");

    expect(privacy).toContain("Google scopes");
    expect(privacy).toContain("We do not sell your personal information");
    expect(privacy).toContain("Cloudflare");
    expect(terms).toContain("Acceptable use");
    expect(terms).toContain("Open-source software");
  });
});

describe("deployable application", () => {
  it("opens at the upload application instead of carrying the marketing homepage", async () => {
    const response = await requestFrom("https://artifacts.example.com", "/");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/upload");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it.each([
    ["/privacy", `${PUBLIC_SITE_ORIGIN}/privacy`],
    ["/terms", `${PUBLIC_SITE_ORIGIN}/terms`],
  ])("sends %s to the ArtifactPass-owned public site", async (path, target) => {
    const response = await requestFrom("https://artifacts.example.com", path);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(target);
  });

  it("keeps customer deployments out of search indexes", async () => {
    const [robots, sitemap] = await Promise.all([
      requestFrom("https://artifacts.example.com", "/robots.txt"),
      requestFrom("https://artifacts.example.com", "/sitemap.xml"),
    ]);

    await expect(robots.text()).resolves.toBe("User-agent: *\nDisallow: /\n");
    expect(sitemap.status).toBe(404);
  });
});
