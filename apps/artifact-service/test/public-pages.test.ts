import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createArtifactApplication } from "../src/server/index";

const requestFrom = (origin: string, path: string): Promise<Response> =>
  Promise.resolve(createArtifactApplication().fetch(
    new Request(`${origin}${path}`),
    env,
  ));

const request = (path: string): Promise<Response> =>
  requestFrom("https://staging.artifactpass.com", path);

describe("public service pages", () => {
  it.each([
    ["/", "ArtifactPass", "Pass work between agents."],
    ["/privacy", "Privacy", "Google and GitHub"],
    ["/terms", "Terms", "temporary bearer link"],
  ])("serves %s without authentication", async (path, title, copy) => {
    const response = await request(path);
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(markup).toContain(`<title>${title}`);
    expect(markup).toContain(copy);
  });

  it("links the public homepage to upload and policy pages", async () => {
    const markup = await (await request("/")).text();

    expect(markup).toContain('href="/upload"');
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('href="/terms"');
  });

  it("serves the approved setup-first homepage with nonce-protected interactions", async () => {
    const response = await request("/");
    const markup = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(markup).toContain("MCP + Agent Skills");
    expect(markup).toContain("pnpm dlx artifactpass@rc --base-url https://staging.artifactpass.com");
    expect(markup).toContain("Exact, temporary artifact handoffs for developers and agentic teams.");
    expect(markup).toContain('id="theme-toggle"');
    expect(markup).toContain("theme-symbol");
    expect(markup).toContain('class="header-divider"');
    expect(markup).toContain('aria-label="View ArtifactPass on GitHub"');
    expect(markup).toContain('data-artifactpass-mark="capability-corridor"');
    expect(markup).toContain('rel="icon" href="/artifactpass-logo.svg"');
    expect(markup).toContain('class="header-action header-action--primary"');
    expect(markup).toContain('id="upload-dialog"');
    expect(markup).toContain('id="pending-file-input"');
    expect(markup).toContain("artifactpass-pending-upload");
    expect(markup).toContain("window.open");
    expect(markup).toContain("artifactpass:auth-complete");
    expect(markup).toContain("/auth/popup/complete");
    expect(policy).toContain("script-src 'nonce-");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("img-src 'self'");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  });

  it("keeps the production install command minimal", async () => {
    const markup = await (await requestFrom("https://artifactpass.com", "/")).text();

    expect(markup).toContain('<code id="install-command">pnpm dlx artifactpass</code>');
    expect(markup).not.toContain("--base-url");
  });

  it("publishes complete service policies instead of placeholder staging notices", async () => {
    const [privacy, terms] = await Promise.all([
      request("/privacy").then((response) => response.text()),
      request("/terms").then((response) => response.text()),
    ]);

    expect(privacy).toContain("Google scopes");
    expect(privacy).toContain("<code>openid</code>");
    expect(privacy).toContain("<code>email</code>");
    expect(privacy).toContain("We do not sell your personal information");
    expect(privacy).toContain("Cloudflare");
    expect(privacy).toContain("GitHub repository");
    expect(terms).toContain("Acceptable use");
    expect(terms).toContain("Open-source software");
    expect(terms).toContain("temporary bearer link");
    expect(privacy).not.toContain("Staging service notice");
    expect(terms).not.toContain("These staging terms");
  });
});
