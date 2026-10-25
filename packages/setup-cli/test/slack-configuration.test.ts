import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addSlackChannel,
  addSlackSource,
  createSlackArchiveConfiguration,
  readSlackArchiveConfiguration,
  writeSlackArchiveConfiguration,
} from "../src/slack/configuration";

describe("non-secret Slack archive setup state", () => {
  test("a cancelled setup can resume from a private local file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-config-"));
    const path = join(directory, "configuration.json");
    try {
      const prepared = createSlackArchiveConfiguration();
      await writeSlackArchiveConfiguration(path, prepared);
      expect(await readSlackArchiveConfiguration(path)).toEqual(prepared);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toMatch(/token|secret|share_url/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("credentials cannot be smuggled into persistent state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifactpass-slack-config-"));
    const path = join(directory, "configuration.json");
    try {
      await expect(writeSlackArchiveConfiguration(path, {
        ...createSlackArchiveConfiguration(), bot_token: "xoxb-test",
      } as never)).rejects.toThrow(/non-secret/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a channel link enables only its exact channel ID", () => {
    const config = addSlackChannel(createSlackArchiveConfiguration(), "https://example.slack.com/archives/C1234567890/p1730000000000100");
    expect(config.enabled_channels).toEqual(["C1234567890"]);
    expect(config.paused).toBe(false);
  });

  test("one setup action enables multiple distinct channels", () => {
    const config = addSlackChannel(
      createSlackArchiveConfiguration(),
      "https://example.slack.com/archives/C1234567890",
      "G1234567890",
      "C1234567890",
    );
    expect(config.enabled_channels).toEqual(["C1234567890", "G1234567890"]);
  });

  test("a private deployment root URL may have a trailing slash, but not a path", () => {
    const config = addSlackSource(createSlackArchiveConfiguration(), "https://artifacts.example.com/");
    expect(config.sources).toEqual(["https://artifactpass.com", "https://artifacts.example.com"]);
    expect(() => addSlackSource(config, "https://artifacts.example.com/a/abc"))
      .toThrow(/without a path/u);
  });
});
