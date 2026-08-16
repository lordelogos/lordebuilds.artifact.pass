import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultLocalConfigPath,
  readLocalBridgeSettings,
  writeLocalBridgeSettings,
} from "../src/config/local-config";
import { configurationFromEnvironment } from "../src/server";

describe("local bridge config", () => {
  it("writes only non-secret settings atomically with private permissions", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-config-test-"));
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 1,
      base_url: "https://artifacts.example.test/",
      workspace_roots: [root],
    });
    expect(await readLocalBridgeSettings(path)).toEqual({
      version: 1,
      base_url: "https://artifacts.example.test/",
      workspace_roots: [root],
    });
    expect((await readFile(path, "utf8"))).not.toContain("token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("lets environment variables override the local config", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-config-test-"));
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 1,
      base_url: "https://config.example.test/",
      workspace_roots: [root],
    });
    const configuration = configurationFromEnvironment({
      ARTIFACT_SHARE_CONFIG_PATH: path,
      ARTIFACT_SHARE_BASE_URL: "https://environment.example.test",
      ARTIFACT_SHARE_WORKSPACE_ROOTS: [root, resolve(root, "nested")].join(delimiter),
      ARTIFACT_SHARE_TOKEN: `as_${"t".repeat(43)}`,
    });
    expect(configuration.baseUrl.origin).toBe("https://environment.example.test");
    expect(configuration.workspaceRoots).toHaveLength(2);
  });

  it("uses explicit and platform-specific config locations", () => {
    expect(defaultLocalConfigPath({ ARTIFACT_SHARE_CONFIG_PATH: "/tmp/custom.json" })).toBe("/tmp/custom.json");
    expect(defaultLocalConfigPath({ APPDATA: "C:\\Users\\Example\\AppData" }, "win32"))
      .toContain("lordebuilds.artifacts.share");
  });
});
