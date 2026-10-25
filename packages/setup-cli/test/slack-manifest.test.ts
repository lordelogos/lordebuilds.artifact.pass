import { describe, expect, test } from "vitest";

import {
  addSlackSource,
  createSlackArchiveConfiguration,
  removeSlackSource,
} from "../src/slack/configuration";
import { createSlackAppManifest, createSlackBootstrapManifest } from "../src/slack/manifest";

const workerUrl = "https://artifactpass-archive.example.workers.dev";

describe("customer-owned Slack manifest", () => {
  test("public-only setup requests only link detection and file-write scopes", () => {
    const config = createSlackArchiveConfiguration();
    expect(config.sources).toEqual(["https://artifactpass.com"]);
    expect(config.enabled_channels).toEqual([]);
    const manifest = createSlackAppManifest(config, workerUrl);
    expect(manifest.features.unfurl_domains).toEqual(["artifactpass.com"]);
    expect(manifest.oauth_config.scopes.bot).toEqual(["links:read", "files:write"]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(["link_shared"]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(`${workerUrl}/slack/events`);
    expect(JSON.stringify(manifest)).not.toContain("history");
  });

  test("the bootstrap manifest can be installed before the signing secret exists", () => {
    const bootstrap = createSlackBootstrapManifest(createSlackArchiveConfiguration());
    expect(bootstrap.oauth_config.scopes.bot).toEqual(["links:read", "files:write"]);
    expect(bootstrap.features).not.toHaveProperty("unfurl_domains");
    expect(bootstrap.settings).not.toHaveProperty("event_subscriptions");
  });

  test("private origins can be added and the public origin removed", () => {
    const config = createSlackArchiveConfiguration();
    const privateOnly = removeSlackSource(addSlackSource(config, "https://artifacts.example.com"), "https://artifactpass.com");
    expect(privateOnly.sources).toEqual(["https://artifacts.example.com"]);
    expect(createSlackAppManifest(privateOnly, workerUrl).features.unfurl_domains).toEqual(["artifacts.example.com"]);
  });

  test("a sixth unfurl domain is rejected before any account operation", () => {
    let config = createSlackArchiveConfiguration();
    for (let index = 1; index <= 4; index++) config = addSlackSource(config, `https://artifacts${index}.example.com`);
    expect(config.sources).toHaveLength(5);
    expect(() => addSlackSource(config, "https://sixth.example.com")).toThrow(/five/i);
  });

  test.each(["http://artifacts.example.com", "https://artifacts.example.com/path", "https://user@artifacts.example.com", "https://localhost:8976"])(
    "rejects an unsafe source origin: %s", (origin) => {
      expect(() => addSlackSource(createSlackArchiveConfiguration(), origin)).toThrow();
    },
  );
});
