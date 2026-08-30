import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createArtifactApplication } from "../src/server/index";

const request = (path: string): Promise<Response> =>
  Promise.resolve(createArtifactApplication().fetch(
    new Request(`https://staging.artifactpass.com${path}`),
    env,
  ));

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
    expect(markup).toContain("pnpm dlx artifactpass");
    expect(markup).toContain("Exact, temporary artifact handoffs for developers and agentic teams.");
    expect(markup).toContain('id="theme-toggle"');
    expect(markup).toContain("theme-symbol");
    expect(markup).toContain('class="header-divider"');
    expect(markup).toContain('aria-label="View ArtifactPass on GitHub"');
    expect(markup).toContain('class="header-action header-action--primary"');
    expect(markup).toContain('id="upload-dialog"');
    expect(markup).toContain('id="pending-file-input"');
    expect(markup).toContain("artifactpass-pending-upload");
    expect(markup).toContain("window.open");
    expect(markup).toContain("artifactpass:auth-complete");
    expect(markup).toContain("/auth/popup/complete");
    expect(policy).toContain("script-src 'nonce-");
    expect(policy).toContain("form-action 'self'");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  });
});
