import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

  it("persists explicit open-development mode as a non-secret setting", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-config-test-"));
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    });

    expect(await readLocalBridgeSettings(path)).toEqual({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    });
    expect(await readFile(path, "utf8")).not.toContain("token");
  });

  it("rejects malformed persisted open-development values", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-config-test-"));
    const path = resolve(root, "config.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      base_url: "https://artifacts.example.test/",
      workspace_roots: [root],
      open_development: false,
    }));

    await expect(readLocalBridgeSettings(path)).rejects.toThrow(
      "open_development must be true when enabled",
    );
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

  describe("deployment origin configuration", () => {
    it.each([
      ["HTTP localhost", "http://localhost:8787", /HTTPS origin/u],
      ["10/8 RFC1918 IPv4", "https://10.20.30.40:8787", /private network/u],
      ["172.16/12 RFC1918 IPv4", "https://172.20.30.40:8787", /private network/u],
      ["192.168/16 RFC1918 IPv4", "https://192.168.30.40:8787", /private network/u],
      ["loopback IPv6", "https://[::1]:8787", /private network/u],
      ["ULA IPv6", "https://[fd12:3456:789a::1]:8787", /private network/u],
    ])("rejects %s in production mode", (_label, baseUrl, expectedError) => {
      expect(() => configurationFromEnvironment({
        ARTIFACT_SHARE_BASE_URL: baseUrl,
        ARTIFACT_SHARE_WORKSPACE_ROOTS: "/tmp/artifacts",
      })).toThrow(expectedError);
    });

    it.each([
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://192.168.1.20:8787",
      "http://[::1]:8787",
      "http://[fd12:3456:789a::1]:8787",
    ])("allows local HTTP origin %s only in explicit development mode", (baseUrl) => {
      const configuration = configurationFromEnvironment({
        ARTIFACT_SHARE_BASE_URL: baseUrl,
        ARTIFACT_SHARE_WORKSPACE_ROOTS: "/tmp/artifacts",
        ARTIFACT_SHARE_OPEN_DEVELOPMENT: "1",
      });

      expect(configuration.baseUrl.origin).toBe(baseUrl);
      expect(configuration.openDevelopment).toBe(true);
    });

    it("uses persisted open-development mode for an installed bridge", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-config-test-"));
      const path = resolve(root, "config.json");
      await writeLocalBridgeSettings(path, {
        version: 1,
        base_url: "http://127.0.0.1:8787/",
        workspace_roots: [root],
        open_development: true,
      });

      const configuration = configurationFromEnvironment({
        ARTIFACT_SHARE_CONFIG_PATH: path,
      });

      expect(configuration.baseUrl.origin).toBe("http://127.0.0.1:8787");
      expect(configuration.openDevelopment).toBe(true);
    });

    it("does not inherit persisted open mode when an environment base URL takes precedence", async () => {
      const root = await mkdtemp(resolve(tmpdir(), "artifact-share-open-config-test-"));
      const path = resolve(root, "config.json");
      await writeLocalBridgeSettings(path, {
        version: 1,
        base_url: "http://127.0.0.1:8787/",
        workspace_roots: [root],
        open_development: true,
      });

      const configuration = configurationFromEnvironment({
        ARTIFACT_SHARE_CONFIG_PATH: path,
        ARTIFACT_SHARE_BASE_URL: "https://artifacts.example.test",
      });

      expect(configuration.baseUrl.origin).toBe("https://artifacts.example.test");
      expect(configuration.openDevelopment).toBe(false);
    });

    it("allows a public HTTPS origin in production mode", () => {
      const configuration = configurationFromEnvironment({
        ARTIFACT_SHARE_BASE_URL: "https://artifacts.example.test",
        ARTIFACT_SHARE_WORKSPACE_ROOTS: "/tmp/artifacts",
      });

      expect(configuration.baseUrl.origin).toBe("https://artifacts.example.test");
      expect(configuration.openDevelopment).toBe(false);
    });

    it.each(["", "0", "01", "true", "yes", " 1", "1 "])(
      "rejects ARTIFACT_SHARE_OPEN_DEVELOPMENT=%j",
      (openDevelopment) => {
        expect(() => configurationFromEnvironment({
          ARTIFACT_SHARE_BASE_URL: "https://artifacts.example.test",
          ARTIFACT_SHARE_WORKSPACE_ROOTS: "/tmp/artifacts",
          ARTIFACT_SHARE_OPEN_DEVELOPMENT: openDevelopment,
        })).toThrow("ARTIFACT_SHARE_OPEN_DEVELOPMENT must be 1 when enabled");
      },
    );
  });

  it("uses explicit and platform-specific config locations", () => {
    expect(defaultLocalConfigPath({ ARTIFACT_SHARE_CONFIG_PATH: "/tmp/custom.json" })).toBe("/tmp/custom.json");
    expect(defaultLocalConfigPath({ APPDATA: "C:\\Users\\Example\\AppData" }, "win32"))
      .toContain("lordebuilds.artifacts.share");
  });
});
