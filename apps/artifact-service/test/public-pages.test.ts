import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createArtifactApplication } from "../src/server/index";
import {
  PUBLIC_SITE_ORIGIN,
  guideInteractionScript,
  publicPageHeaders,
  renderAiCatalogJson,
  renderLlmsTxt,
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
    ["how-it-works", "How ArtifactPass Works", "temporary link"],
    ["for-ai-agents", "Artifact Sharing for AI Agents", "MCP-compatible"],
    ["private-deployments", "Private ArtifactPass Deployments", "Cloudflare account"],
    ["guides", "ArtifactPass Setup Guides", "Choose the setup path"],
    ["agent-setup-guide", "Set Up ArtifactPass for an AI Agent", "project-specific"],
    ["private-deployment-guide", "Private ArtifactPass Deployment Guide", "artifacts.example.com"],
    ["private-teammate-guide", "Join a Private ArtifactPass Deployment", "publisher access"],
    ["security", "ArtifactPass Security", "bearer link"],
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
    const sitemap = renderSitemapXml();
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/how-it-works</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/for-ai-agents</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/private-deployments</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/guides</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/guides/agent-setup</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/guides/private-deployment</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/guides/private-teammate</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/security</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/privacy</loc>`);
    expect(sitemap).toContain(`<loc>${PUBLIC_SITE_ORIGIN}/terms</loc>`);
    expect(markup).toContain('rel="ai-catalog" href="/.well-known/ai-catalog.json"');
    expect(markup).toContain('rel="ard" href="/.well-known/ard.json"');
  });

  it("publishes machine-readable agent discovery documents", () => {
    const llmsTxt = renderLlmsTxt();
    const catalog = JSON.parse(renderAiCatalogJson()) as {
      specVersion?: string;
      entries?: readonly { identifier?: string; type?: string; url?: string }[];
    };

    expect(llmsTxt).toMatch(/^# ArtifactPass\n/u);
    expect(llmsTxt).toContain(`[ArtifactPass homepage](${PUBLIC_SITE_ORIGIN}/)`);
    expect(llmsTxt).toContain("share-artifact/SKILL.md");
    expect(catalog.specVersion).toBe("1.0");
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        identifier: "urn:air:artifactpass.com:skill:share-artifact",
        type: 'text/markdown; profile="urn:air:agent-skills"',
        url: expect.stringContaining("share-artifact/SKILL.md"),
      }),
    ]));
  });

  it("keeps public labels and Cloudflare analytics compatible with quality audits", () => {
    const markup = renderStaticPublicPage("home");
    const contentSecurityPolicy = publicPageHeaders("test")["Content-Security-Policy"];

    expect(markup).toContain(".explain-label{display:block;margin-bottom:20px;color:var(--ash)");
    expect(contentSecurityPolicy).toContain("https://static.cloudflareinsights.com");
    expect(contentSecurityPolicy).toContain("https://cloudflareinsights.com");
  });

  it("links the public homepage to the app and policy pages", () => {
    const markup = renderStaticPublicPage("home");

    expect(markup).toContain('href="/upload"');
    expect(markup).toContain('href="#how"');
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain('href="/how-it-works"');
    expect(markup).toContain('href="/for-ai-agents"');
    expect(markup).toContain('href="/private-deployments"');
    expect(markup).toContain('href="/guides"');
    expect(markup).toContain('href="/security"');
  });

  it("gives each discovery page unique metadata and structured data", () => {
    for (const [page, path] of [
      ["how-it-works", "/how-it-works"],
      ["for-ai-agents", "/for-ai-agents"],
      ["private-deployments", "/private-deployments"],
      ["guides", "/guides"],
      ["agent-setup-guide", "/guides/agent-setup"],
      ["private-deployment-guide", "/guides/private-deployment"],
      ["private-teammate-guide", "/guides/private-teammate"],
      ["security", "/security"],
    ] as const) {
      const markup = renderStaticPublicPage(page);

      expect(markup).toContain(`rel="canonical" href="${PUBLIC_SITE_ORIGIN}${path}"`);
      expect(markup).toContain('type="application/ld+json"');
      expect(markup).toMatch(/"@type":"(?:WebPage|HowTo)"/u);
      expect(markup).toContain('"@type":"BreadcrumbList"');
    }
  });

  it("publishes image-led setup guides with complete user paths", () => {
    const guides = renderStaticPublicPage("guides");
    const agentSetup = renderStaticPublicPage("agent-setup-guide");
    const privateDeployment = renderStaticPublicPage("private-deployment-guide");
    const privateTeammate = renderStaticPublicPage("private-teammate-guide");

    expect(guides).toContain('href="/guides/agent-setup"');
    expect(guides).toContain('href="/guides/private-deployment"');
    expect(guides).toContain('href="/guides/private-teammate"');

    expect(agentSetup).toContain('"@type":"HowTo"');
    expect(agentSetup).toContain("pnpm dlx artifactpass");
    expect(agentSetup).toContain("Connect ArtifactPass");
    expect(agentSetup).toContain('data-copy-command=""');
    expect(agentSetup).toContain(guideInteractionScript);
    expect(agentSetup).toContain('/guides/agent-setup/run-command.svg');
    expect(agentSetup).toContain('/guides/agent-setup/connect-agent.svg');
    expect(agentSetup).toContain("If the browser does not open");
    expect(agentSetup).not.toContain("prints the approval URL as well as trying to open it");

    expect(privateDeployment).toContain('"@type":"HowTo"');
    expect(privateDeployment).toContain("Administrator guide");
    expect(privateDeployment).toContain("15 minutes");
    expect(privateDeployment).toContain("30 minutes");
    expect(privateDeployment).toContain("1 hour");
    expect(privateDeployment).toContain("1 day");
    expect(privateDeployment).toContain("7 days");
    expect(privateDeployment).toContain("Edit hostname");
    expect(privateDeployment).toContain("Edit sign-in");
    expect(privateDeployment).toContain("Edit allowed people");
    expect(privateDeployment).toContain("Edit link lifetimes");
    expect(privateDeployment).toContain("Save and exit");
    expect(privateDeployment).toContain("Approved company email domains:");
    expect(privateDeployment).toContain("Specific email addresses:");
    expect(privateDeployment).toContain("Existing company login");
    expect(privateDeployment).toContain("does not create a separate ArtifactPass email-address allow list");
    expect(privateDeployment).toMatch(/administrator[^.]*outside[^.]*domain[^.]*specific-address/iu);
    expect(privateDeployment).toContain("example.com");
    expect(privateDeployment).toContain("artifacts.example.com");
    expect(privateDeployment).toContain('/guides/private-deployment/connect-domain.svg');

    expect(privateTeammate).toContain('"@type":"HowTo"');
    expect(privateTeammate).toContain("Email verification code");
    expect(privateTeammate).toContain("Existing company login");
    expect(privateTeammate).toContain("pnpm dlx artifactpass --base-url https://artifacts.example.com");
    expect(privateTeammate).toContain('/guides/private-teammate/teammate-setup.svg');

    for (const markup of [guides, agentSetup, privateDeployment, privateTeammate]) {
      expect(markup).not.toContain("lordebuilds.com");
      expect(markup).not.toContain("lordegraphics");
      expect(markup).not.toContain("paulehiks");
    }
  });

  it("puts every pnpm guide command inside the accessible copy control", () => {
    const guideMarkup = [
      renderStaticPublicPage("guides"),
      renderStaticPublicPage("agent-setup-guide"),
      renderStaticPublicPage("private-deployment-guide"),
      renderStaticPublicPage("private-teammate-guide"),
    ].join("\n");
    const pnpmCommands = [...guideMarkup.matchAll(/<code(?:\s[^>]*)?>(pnpm dlx [^<]+)<\/code>/gu)]
      .map((match) => match[1]);
    const copyablePnpmCommands = [...guideMarkup.matchAll(
      /<div class="guide-command"><code data-guide-command="">(pnpm dlx [^<]+)<\/code><button type="button" data-copy-command="" aria-label="Copy command: [^"]+">Copy<\/button><span class="visually-hidden" data-copy-status="" aria-live="polite"><\/span><\/div>/gu,
    )].map((match) => match[1]);

    expect(pnpmCommands).not.toHaveLength(0);
    expect(copyablePnpmCommands).toEqual(pnpmCommands);
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
