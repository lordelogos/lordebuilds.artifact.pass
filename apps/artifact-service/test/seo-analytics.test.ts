import { describe, expect, it, vi } from "vitest";
import { PUBLIC_HUMAN_EXPIRY_SECONDS } from "artifact-protocol";

import {
  handleSeoEventRequest,
  seoAnalyticsScript,
} from "../../artifact-pages/src/seo-analytics";
import {
  renderPublicPage,
  renderStaticPublicPage,
} from "../../artifact-pages/src/public-pages";

const publicConfiguration = {
  deploymentMode: "public" as const,
  allowedExpirySeconds: PUBLIC_HUMAN_EXPIRY_SECONDS,
};

const analyticsRequest = (body: unknown, overrides: RequestInit = {}) => new Request(
  "https://artifactpass.com/seo-events",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      Origin: "https://artifactpass.com",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
    ...overrides,
  },
);

const createAnalyticsDatabase = () => {
  const statements: Array<{ query: string; values: Array<string | number> }> = [];
  const prepare = vi.fn((query: string) => {
    const statement = {
      bind: vi.fn((...values: Array<string | number>) => {
        statements.push({ query, values });
        return statement;
      }),
    };
    return statement;
  });
  const batch = vi.fn(async () => []);
  return { database: { prepare, batch }, batch, statements };
};

describe("public SEO analytics", () => {
  it("renders anonymous tracking only on the canonical static site", () => {
    const canonicalMarkup = renderStaticPublicPage("home");
    const privateMarkup = renderPublicPage(
      "home",
      "test-nonce",
      "https://artifacts.example.com/",
      { ...publicConfiguration, deploymentMode: "private" },
    );

    expect(canonicalMarkup).toContain(seoAnalyticsScript);
    expect(canonicalMarkup).toContain('"/seo-events"');
    expect(privateMarkup).not.toContain(seoAnalyticsScript);
    expect(privateMarkup).not.toContain('"/seo-events"');
  });

  it("discloses the public-site measurement without implying artifact tracking", () => {
    const privacyMarkup = renderStaticPublicPage("privacy");

    expect(privacyMarkup).toContain("Public-site analytics:");
    expect(privacyMarkup).toContain("does not place analytics cookies");
    expect(privacyMarkup).toContain("collect artifact links, filenames, or contents");
    expect(privacyMarkup).toContain("pruned after 90 days");
  });

  it("records only an allowlisted public event and coarse campaign fields", async () => {
    const { database, batch, statements } = createAnalyticsDatabase();
    const response = await handleSeoEventRequest(
      analyticsRequest({
        event: "setup_command_copy",
        page: "/guides/agent-setup",
        source: "linkedin",
        medium: "organic-social",
        campaign: "agent-handoffs",
      }),
      database,
    );

    expect(response.status).toBe(204);
    expect(batch).toHaveBeenCalledOnce();
    expect(statements[0]?.query).toContain("INSERT INTO seo_event_daily");
    expect(statements[0]?.values.slice(1)).toEqual([
      "setup_command_copy",
      "/guides/agent-setup",
      "linkedin",
      "organic-social",
      "agent-handoffs",
    ]);
    expect(statements[1]?.query).toContain("DELETE FROM seo_event_daily");
  });

  it.each([
    ["unknown event", { event: "document_uploaded", page: "/" }],
    ["private route", { event: "page_view", page: "/a/secret-capability" }],
    ["untrusted campaign value", { event: "page_view", page: "/", campaign: "someone@example.com" }],
    ["person-like campaign value", { event: "page_view", page: "/", campaign: "alice.smith" }],
    ["phone-like campaign value", { event: "page_view", page: "/", campaign: "15551234567" }],
    ["identifier-like campaign value", { event: "page_view", page: "/", campaign: "92bfc550-2c8f-4e51-a9e1-8007cad223f4" }],
    ["null payload", null],
  ])("rejects %s", async (_name, body) => {
    const { database, batch } = createAnalyticsDatabase();
    const response = await handleSeoEventRequest(analyticsRequest(body), database);

    expect(response.status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects a body over the endpoint limit without a Content-Length header", async () => {
    const { database, batch } = createAnalyticsDatabase();
    const request = new Request("https://artifactpass.com/seo-events", {
      method: "POST",
      headers: { Origin: "https://artifactpass.com" },
      body: JSON.stringify({ event: "page_view", page: "/", campaign: "a".repeat(2_000) }),
    });
    request.headers.delete("Content-Length");

    const response = await handleSeoEventRequest(request, database);

    expect(response.status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin submissions", async () => {
    const { database, batch } = createAnalyticsDatabase();
    const response = await handleSeoEventRequest(
      analyticsRequest(
        { event: "page_view", page: "/" },
        { headers: { "Content-Type": "application/json", Origin: "https://example.com" } },
      ),
      database,
    );

    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects browser submissions that fetch metadata marks as cross-site", async () => {
    const { database, batch } = createAnalyticsDatabase();
    const response = await handleSeoEventRequest(
      analyticsRequest(
        { event: "page_view", page: "/" },
        {
          headers: {
            "CF-Connecting-IP": "203.0.113.11",
            Origin: "https://artifactpass.com",
            "Sec-Fetch-Site": "cross-site",
          },
        },
      ),
      database,
    );

    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it("throttles repeated valid events from one edge client", async () => {
    const { database, batch } = createAnalyticsDatabase();
    const responses = [];
    for (let index = 0; index < 61; index += 1) {
      responses.push(await handleSeoEventRequest(
        analyticsRequest(
          { event: "page_view", page: "/" },
          {
            headers: {
              "CF-Connecting-IP": "203.0.113.99",
              Origin: "https://artifactpass.com",
              "Sec-Fetch-Site": "same-origin",
            },
          },
        ),
        database,
      ));
    }

    expect(responses.slice(0, 60).every((response) => response.status === 204)).toBe(true);
    expect(responses[60]?.status).toBe(429);
    expect(responses[60]?.headers.get("Retry-After")).toBe("60");
    expect(batch).toHaveBeenCalledTimes(60);
  });
});
