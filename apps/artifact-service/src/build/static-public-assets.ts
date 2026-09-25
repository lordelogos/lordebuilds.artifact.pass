import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

import {
  homepageBootScript,
  homepageInteractionScript,
  publicStyles,
  themeInteractionScript,
} from "../web/routes/public-homepage.tsx";
import {
  PUBLIC_SITE_ORIGIN,
  renderRobotsTxt,
  renderSitemapXml,
  renderStaticPublicPage,
} from "../web/routes/public-pages.tsx";

const contentHash = (content: string): string =>
  `'sha256-${createHash("sha256").update(content).digest("base64")}'`;

const staticContentSecurityPolicy = [
  "default-src 'none'",
  `style-src ${contentHash(publicStyles)}`,
  `script-src 'self' ${[
    homepageBootScript,
    themeInteractionScript,
    homepageInteractionScript,
  ].map(contentHash).join(" ")}`,
  "connect-src 'self'",
  "img-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const staticHeaders = [
  "/",
  `/privacy`,
  `/terms`,
].map((path) => [
  path,
  "  Cache-Control: public, max-age=0, must-revalidate",
  "  Cross-Origin-Opener-Policy: same-origin-allow-popups",
  `  Content-Security-Policy: ${staticContentSecurityPolicy}`,
  "  Referrer-Policy: no-referrer",
  "  X-Content-Type-Options: nosniff",
].join("\n")).join("\n\n");

const pagesPreviewHeaders = [
  "https://artifactpass-site.pages.dev/*",
  "  X-Robots-Tag: noindex, nofollow, noarchive",
  "",
  "https://*.artifactpass-site.pages.dev/*",
  "  X-Robots-Tag: noindex, nofollow, noarchive",
].join("\n");

export const pagesFunctionRoutes = {
  version: 1,
  include: [
    "/health",
    "/session/*",
    "/auth/*",
    "/upload",
    "/upload/*",
    "/connect",
    "/connect/*",
    "/api/*",
    "/a/*",
  ],
  exclude: [],
} as const;

export const staticPublicAssets = (outputDirectory: string): Plugin => ({
  name: "artifactpass-static-public-assets",
  apply: "build",
  applyToEnvironment: (environment) => environment.name === "client",
  async closeBundle() {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(resolve(outputDirectory, "index.html"), renderStaticPublicPage("home")),
      writeFile(resolve(outputDirectory, "privacy.html"), renderStaticPublicPage("privacy")),
      writeFile(resolve(outputDirectory, "terms.html"), renderStaticPublicPage("terms")),
      writeFile(
        resolve(outputDirectory, "robots.txt"),
        renderRobotsTxt(`${PUBLIC_SITE_ORIGIN}/robots.txt`),
      ),
      writeFile(resolve(outputDirectory, "sitemap.xml"), renderSitemapXml()),
      writeFile(
        resolve(outputDirectory, "_headers"),
        `${staticHeaders}\n\n${pagesPreviewHeaders}\n`,
      ),
      writeFile(
        resolve(outputDirectory, "_routes.json"),
        `${JSON.stringify(pagesFunctionRoutes, null, 2)}\n`,
      ),
    ]);
  },
});
