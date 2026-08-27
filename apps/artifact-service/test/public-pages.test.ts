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
    ["/", "ArtifactPass", "Share work with people and agents"],
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
});
