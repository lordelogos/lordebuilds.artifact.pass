import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindLocalBridgeWorkspace,
  readLocalBridgeSettings,
  updateLocalBridgeSettings,
  upsertLocalBridgeProfile,
  writeLocalBridgeSettings,
} from "../src/config/local-config";

describe("local bridge config transactions", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("preserves concurrent workspace grants", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-config-transaction-"));
    temporaryRoots.push(root);
    const path = resolve(root, "config.json");
    const firstRoot = resolve(root, "first");
    const secondRoot = resolve(root, "second");
    await writeLocalBridgeSettings(path, {
      version: 2,
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: [root],
        },
      },
    });

    await Promise.all([
      updateLocalBridgeSettings(path, async (settings) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        if (settings === null) throw new Error("missing settings");
        return bindLocalBridgeWorkspace(settings, firstRoot, "production");
      }),
      updateLocalBridgeSettings(path, async (settings) => {
        if (settings === null) throw new Error("missing settings");
        return bindLocalBridgeWorkspace(settings, secondRoot, "production");
      }),
    ]);

    await expect(readLocalBridgeSettings(path)).resolves.toMatchObject({
      workspace_profiles: {
        [firstRoot]: "production",
        [secondRoot]: "production",
      },
    });
  });

  it("leaves the previous config readable when a mutation exceeds the size limit", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "artifactpass-config-size-"));
    temporaryRoots.push(root);
    const path = resolve(root, "config.json");
    await writeLocalBridgeSettings(path, {
      version: 2,
      active_profile: "production",
      profiles: {
        production: {
          base_url: "https://artifactpass.com",
          workspace_roots: [root],
        },
      },
    });
    const before = await readFile(path, "utf8");

    await expect(updateLocalBridgeSettings(path, (settings) => {
      if (settings === null) throw new Error("missing settings");
      let updated = settings;
      for (let index = 0; index < 700; index += 1) {
        const name = `profile-${index}`;
        updated = upsertLocalBridgeProfile(updated, name, {
          base_url: `https://${name}.example.com`,
          workspace_roots: [resolve(root, name)],
        });
      }
      return updated;
    })).rejects.toThrow("ArtifactPass config is too large");

    await expect(readFile(path, "utf8")).resolves.toBe(before);
    await expect(readLocalBridgeSettings(path)).resolves.toMatchObject({
      active_profile: "production",
    });
  });
});
