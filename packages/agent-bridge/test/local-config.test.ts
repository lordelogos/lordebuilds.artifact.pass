import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultLocalConfigPath,
  legacyLocalConfigPath,
  readCompatibleLocalBridgeSettingsSync,
  readLocalBridgeSettings,
  selectLocalBridgeProfile,
  setActiveLocalBridgeProfile,
  upsertLocalBridgeProfile,
  writeLocalBridgeSettings,
} from "../src/config/local-config";
import { configurationFromEnvironment } from "../src/server";
import { FilePublicationJournal } from "../src/state/publication-journal";

describe("local bridge config", () => {
  it("migrates a legacy local connection into the local profile without losing it", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-legacy-config-test-"));
    const path = resolve(root, "config.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    }));

    expect(await readLocalBridgeSettings(path)).toEqual({
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          workspace_roots: [root],
          open_development: true,
          publication_state: "legacy",
        },
      },
    });
  });

  it("keeps local and production profiles together and selects either explicitly", () => {
    const local = {
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: ["/tmp/artifacts"],
      open_development: true as const,
    };
    const production = {
      base_url: "https://artifactpass.com/",
      workspace_roots: ["/tmp/artifacts"],
      pdf_key_id: "artifactpass-primary",
    };
    const withLocal = upsertLocalBridgeProfile(null, "local", local);
    const withBoth = upsertLocalBridgeProfile(withLocal, "production", production);

    expect(withBoth.active_profile).toBe("production");
    expect(withBoth.profiles).toEqual({ local, production });
    expect(selectLocalBridgeProfile(withBoth, "local")).toEqual({ name: "local", settings: local });
    expect(selectLocalBridgeProfile(withBoth, "production")).toEqual({
      name: "production",
      settings: production,
    });
    expect(setActiveLocalBridgeProfile(withBoth, "local").active_profile).toBe("local");
    expect(() => selectLocalBridgeProfile(withBoth, "staging")).toThrow("Unknown ArtifactPass profile");
    expect(() => selectLocalBridgeProfile(withBoth, "constructor")).toThrow("Unknown ArtifactPass profile");
  });

  it("selects the deployment bound to the current workspace", () => {
    const personalRoot = "/tmp/personal-project";
    const companyRoot = "/tmp/company-project";
    const settings = {
      version: 2 as const,
      active_profile: "production",
      workspace_profiles: {
        [personalRoot]: "production",
        [companyRoot]: "company",
      },
      profiles: {
        production: {
          base_url: "https://artifactpass.com/",
          workspace_roots: [personalRoot],
        },
        company: {
          base_url: "https://artifacts.company.example/",
          workspace_roots: [companyRoot],
        },
      },
    };

    expect(selectLocalBridgeProfile(settings, undefined, resolve(companyRoot, "packages", "app")))
      .toMatchObject({ name: "company" });
    expect(selectLocalBridgeProfile(settings, undefined, resolve(personalRoot, "docs")))
      .toMatchObject({ name: "production" });
    expect(selectLocalBridgeProfile(settings, "production", companyRoot))
      .toMatchObject({ name: "production" });
  });

  it("loads the bound deployment into each workspace's MCP session", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-workspace-binding-test-"));
    const path = resolve(root, "config.json");
    const personalRoot = resolve(root, "personal");
    const companyRoot = resolve(root, "company");
    await Promise.all([mkdir(personalRoot), mkdir(companyRoot)]);
    await writeLocalBridgeSettings(path, {
      version: 2,
      active_profile: "production",
      workspace_profiles: {
        [personalRoot]: "production",
        [companyRoot]: "company",
      },
      profiles: {
        production: {
          base_url: "https://artifactpass.com/",
          workspace_roots: [personalRoot],
        },
        company: {
          base_url: "https://artifacts.company.example/",
          workspace_roots: [companyRoot],
        },
      },
    });

    const environment = { ARTIFACTPASS_CONFIG_PATH: path };
    expect(configurationFromEnvironment(environment, personalRoot)).toMatchObject({
      profileName: "production",
      baseUrl: new URL("https://artifactpass.com"),
    });
    expect(configurationFromEnvironment(environment, companyRoot)).toMatchObject({
      profileName: "company",
      baseUrl: new URL("https://artifacts.company.example"),
    });
  });

  it("rejects an inherited property as the active profile", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-profile-key-test-"));
    const path = resolve(root, "config.json");
    await writeFile(path, JSON.stringify({
      version: 2,
      active_profile: "constructor",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          workspace_roots: [root],
          open_development: true,
        },
      },
    }));

    await expect(readLocalBridgeSettings(path)).rejects.toThrow("Unknown ArtifactPass profile: constructor");
  });

  it("keeps a legacy SQLite publication journal on its original path across upgrade", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-journal-migration-test-"));
    const path = resolve(root, "config.json");
    const legacyStatePath = `${path}.publication-state`;
    await writeFile(path, JSON.stringify({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    }));
    const commitment = "a".repeat(64);
    const expiresAt = Date.now() + 60_000;
    const original = await new FilePublicationJournal(legacyStatePath).prepare(commitment, expiresAt);

    const configuration = configurationFromEnvironment({ ARTIFACT_SHARE_CONFIG_PATH: path });

    expect(configuration.publicationStatePath).toBe(legacyStatePath);
    await expect(new FilePublicationJournal(configuration.publicationStatePath ?? "")
      .prepare(commitment, expiresAt)).resolves.toEqual(original);
    expect((await stat(`${legacyStatePath}.sqlite3`)).mode & 0o777).toBe(0o600);
    await expect(stat(`${path}.local.publication-state.sqlite3`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors an explicit legacy config path when a default ArtifactPass config exists", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-explicit-legacy-config-test-"));
    const artifactpassPath = resolve(root, "artifactpass", "config.json");
    const legacyPath = resolve(root, "explicit-legacy.json");
    await writeLocalBridgeSettings(artifactpassPath, {
      version: 1,
      base_url: "https://staging.artifactpass.com/",
      workspace_roots: [root],
      pdf_key_id: "artifactpass-staging",
    });
    await writeLocalBridgeSettings(legacyPath, {
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    });

    const configuration = configurationFromEnvironment({
      XDG_CONFIG_HOME: root,
      ARTIFACT_SHARE_CONFIG_PATH: legacyPath,
    });

    expect(configuration.baseUrl.origin).toBe("http://127.0.0.1:8787");
    expect(configuration.profileName).toBe("local");
    expect(configuration.publicationStatePath).toBe(`${legacyPath}.publication-state`);
  });

  it("uses ARTIFACT_SHARE_PROFILE without rewriting the active profile", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-profile-config-test-"));
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          workspace_roots: [root],
          open_development: true,
        },
        production: {
          base_url: "https://artifactpass.com/",
          workspace_roots: [root],
          pdf_key_id: "artifactpass-primary",
        },
      },
    });

    const configuration = configurationFromEnvironment({
      ARTIFACT_SHARE_CONFIG_PATH: path,
      ARTIFACT_SHARE_PROFILE: "production",
    });

    expect(configuration.profileName).toBe("production");
    expect(configuration.baseUrl.origin).toBe("https://artifactpass.com");
    expect(configuration.pdfProvenanceKeyId).toBe("artifactpass-primary");
    expect((await readLocalBridgeSettings(path)).active_profile).toBe("local");
  });

  it("writes only non-secret settings atomically with private permissions", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-config-test-"));
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 1,
      base_url: "https://artifacts.example.test/",
      workspace_roots: [root],
      pdf_key_id: "artifactpass-primary",
    });
    expect(await readLocalBridgeSettings(path)).toEqual({
      version: 2,
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifacts.example.test/",
          workspace_roots: [root],
          pdf_key_id: "artifactpass-primary",
          publication_state: "legacy",
        },
      },
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
      version: 2,
      active_profile: "local",
      profiles: {
        local: {
          base_url: "http://127.0.0.1:8787/",
          workspace_roots: [root],
          open_development: true,
          publication_state: "legacy",
        },
      },
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

  it("loads the hosted PDF key from the OS credential store without persisting it", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifact-share-pdf-config-test-"));
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 1,
      base_url: "https://artifacts.example.test/",
      workspace_roots: [root],
      pdf_key_id: "artifactpass-primary",
    });

    const configuration = configurationFromEnvironment({ ARTIFACT_SHARE_CONFIG_PATH: path });

    expect(configuration.pdfProvenanceKeyId).toBe("artifactpass-primary");
    expect(configuration.pdfProvenanceStore).toBeDefined();
    expect(await readFile(path, "utf8")).not.toContain("private");
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
    expect(configuration.profileName).toBe("production");
    expect(configuration.publicationStatePath).toBe(`${path}.publication-state`);
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
        })).toThrow("ARTIFACTPASS_OPEN_DEVELOPMENT must be 1 when enabled");
      },
    );
  });

  it("uses explicit and platform-specific config locations", () => {
    expect(defaultLocalConfigPath({ ARTIFACTPASS_CONFIG_PATH: "/tmp/custom.json" })).toBe("/tmp/custom.json");
    expect(defaultLocalConfigPath({ APPDATA: "C:\\Users\\Example\\AppData" }, "win32"))
      .toContain("artifactpass");
    expect(legacyLocalConfigPath({ APPDATA: "C:\\Users\\Example\\AppData" }, "win32"))
      .toContain("lordebuilds.artifacts.share");
  });

  it("reads legacy config only when ArtifactPass config is absent", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-compatible-config-test-"));
    const legacyPath = resolve(root, "lordebuilds.artifacts.share", "config.json");
    await mkdir(resolve(root, "lordebuilds.artifacts.share"), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      base_url: "http://127.0.0.1:8787/",
      workspace_roots: [root],
      open_development: true,
    }));

    const resolved = readCompatibleLocalBridgeSettingsSync({ XDG_CONFIG_HOME: root });

    expect(resolved.source).toBe("legacy");
    expect(resolved.path).toBe(legacyPath);
    expect(resolved.settings.active_profile).toBe("local");
  });

  it("rejects differing valid ArtifactPass and legacy configs", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-config-conflict-test-"));
    const artifactpassPath = resolve(root, "artifactpass", "config.json");
    const legacyPath = resolve(root, "lordebuilds.artifacts.share", "config.json");
    await writeLocalBridgeSettings(artifactpassPath, {
      version: 2,
      active_profile: "production",
      profiles: { production: { base_url: "https://artifactpass.com/", workspace_roots: [root] } },
    });
    await writeLocalBridgeSettings(legacyPath, {
      version: 2,
      active_profile: "production",
      profiles: { production: { base_url: "https://other.example/", workspace_roots: [root] } },
    });

    expect(() => readCompatibleLocalBridgeSettingsSync({ XDG_CONFIG_HOME: root }))
      .toThrow("configs conflict");
  });

  it("accepts new environment names and rejects differing legacy aliases", () => {
    const base = {
      ARTIFACTPASS_BASE_URL: "https://artifactpass.com",
      ARTIFACTPASS_WORKSPACE_ROOTS: "/tmp/artifacts",
    };
    expect(configurationFromEnvironment(base).baseUrl.origin).toBe("https://artifactpass.com");
    expect(() => configurationFromEnvironment({
      ...base,
      ARTIFACT_SHARE_BASE_URL: "https://other.example",
    })).toThrow("ARTIFACTPASS_BASE_URL conflicts");
  });

  it("starts an unconfigured marketplace plugin against public ArtifactPass without authenticating", async () => {
    const configurationHome = await mkdtemp(resolve(tmpdir(), "artifactpass-unconfigured-plugin-"));
    const configuration = configurationFromEnvironment({ XDG_CONFIG_HOME: configurationHome });

    expect(configuration.baseUrl.origin).toBe("https://artifactpass.com");
    expect(configuration.workspaceRoots).toEqual([resolve(process.cwd())]);
    expect(configuration.openDevelopment).toBe(false);
    expect(configuration.headless).toBe(false);
  });
});
