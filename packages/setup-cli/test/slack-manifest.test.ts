import { describe, expect, test } from "vitest";

import {
  addSlackSource,
  createSlackArchiveConfiguration,
  removeSlackSource,
} from "../src/slack/configuration";
import { createSlackAppManifest, createSlackInitialManifest } from "../src/slack/manifest";

const workerUrl = "https://artifactpass-archive.example.workers.dev";

describe("customer-owned Slack manifest", () => {
  test("public-only setup requests link detection, unavailable-link previews, and file upload", () => {
    const config = createSlackArchiveConfiguration();
    expect(config.sources).toEqual(["https://artifactpass.com"]);
    expect(config.enabled_channels).toEqual([]);
    const manifest = createSlackAppManifest(config, workerUrl);
    expect(manifest.features.unfurl_domains).toEqual(["artifactpass.com"]);
    expect(manifest.oauth_config.scopes.bot).toEqual(["links:read", "links:write", "files:write"]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(["link_shared"]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(`${workerUrl}/slack/events`);
    expect(JSON.stringify(manifest)).not.toContain("history");
  });

  test("the first manifest already contains link domains and event delivery", () => {
    const config = addSlackSource(createSlackArchiveConfiguration(), "https://artifacts.example.com");
    const initial = createSlackInitialManifest(config, workerUrl);
    expect(initial).toEqual(createSlackAppManifest(config, workerUrl));
    expect(initial.features.unfurl_domains).toEqual(["artifactpass.com", "artifacts.example.com"]);
    expect(initial.settings.event_subscriptions.request_url).toBe(`${workerUrl}/slack/events`);
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
