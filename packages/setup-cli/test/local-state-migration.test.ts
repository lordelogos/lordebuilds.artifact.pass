import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  FilePublicationJournal,
  readLocalBridgeSettings,
  type CredentialStore,
} from "agent-bridge";
import { describe, expect, it, vi } from "vitest";

import { migrateLegacyLocalState } from "../src/local-state-migration";

const memoryStores = () => {
  const artifactpass = new Map<string, string>();
  const legacy = new Map<string, string>();
  const factory = (values: Map<string, string>) => (account: string): CredentialStore => ({
    get: async () => values.get(account) ?? null,
    set: async (value) => { values.set(account, value); },
    delete: async () => { values.delete(account); },
  });
  return {
    artifactpass,
    legacy,
    artifactpassFactory: factory(artifactpass),
    legacyFactory: factory(legacy),
  };
};

const legacyFixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), "artifactpass-state-migration-test-"));
  const artifactpassConfigPath = resolve(root, "artifactpass", "config.json");
  const legacyConfigPath = resolve(root, "lordebuilds.artifacts.share", "config.json");
  await mkdir(resolve(root, "lordebuilds.artifacts.share"), { recursive: true });
  const legacyContents = JSON.stringify({
    version: 1,
    base_url: "https://artifactpass.com/",
    workspace_roots: [root],
    pdf_key_id: "artifactpass-primary",
  });
  await writeFile(legacyConfigPath, legacyContents);
  return { root, artifactpassConfigPath, legacyConfigPath, legacyContents };
};

describe("local state migration", () => {
  it("preserves config, credentials, signing key, and pending retry identity", async () => {
    const fixture = await legacyFixture();
    const stores = memoryStores();
    const token = `as_${"t".repeat(43)}`;
    const signingKey = "private-key-material";
    stores.legacy.set("agent-token", token);
    stores.legacy.set("pdf-signing-key:artifactpass-primary", signingKey);
    const legacyJournalPath = `${fixture.legacyConfigPath}.publication-state`;
    const commitment = "a".repeat(64);
    const expiresAt = Date.now() + 60_000;
    const pending = await new FilePublicationJournal(legacyJournalPath).prepare(commitment, expiresAt);

    const result = await migrateLegacyLocalState({
      artifactpassConfigPath: fixture.artifactpassConfigPath,
      legacyConfigPath: fixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
    });

    expect(result.status).toBe("committed");
    expect(result.legacyPreserved).toBe(true);
    expect(await readFile(fixture.legacyConfigPath, "utf8")).toBe(fixture.legacyContents);
    expect(stores.artifactpass.get("agent-token")).toBe(token);
    expect(stores.artifactpass.get("pdf-signing-key:artifactpass-primary")).toBe(signingKey);
    const migrated = await readLocalBridgeSettings(fixture.artifactpassConfigPath);
    expect(migrated.profiles.production).toMatchObject({
      credential_namespace: "artifactpass",
      publication_state: "legacy",
      publication_state_path: legacyJournalPath,
    });
    await expect(new FilePublicationJournal(legacyJournalPath).prepare(commitment, expiresAt))
      .resolves.toEqual(pending);
    expect((await stat(fixture.artifactpassConfigPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(fixture.artifactpassConfigPath, "utf8")).not.toContain(token);
    expect(await readFile(`${fixture.artifactpassConfigPath}.migration.json`, "utf8"))
      .not.toContain(signingKey);
  });

  it("rejects differing valid credentials without writing new state", async () => {
    const fixture = await legacyFixture();
    const stores = memoryStores();
    stores.artifactpass.set("agent-token", `as_${"a".repeat(43)}`);
    stores.legacy.set("agent-token", `as_${"b".repeat(43)}`);

    await expect(migrateLegacyLocalState({
      artifactpassConfigPath: fixture.artifactpassConfigPath,
      legacyConfigPath: fixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
    })).rejects.toThrow("credentials conflict");
    await expect(readFile(fixture.artifactpassConfigPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(stores.artifactpass.get("agent-token")).toBe(`as_${"a".repeat(43)}`);
  });

  it.each(["started", "credentials-staged", "config-staged", "verified"] as const)(
    "rolls back every owned mutation when %s fails",
    async (failedStage) => {
    const fixture = await legacyFixture();
    const stores = memoryStores();
    stores.legacy.set("agent-token", `as_${"t".repeat(43)}`);
    stores.legacy.set("pdf-signing-key:artifactpass-primary", "signing-key");

    await expect(migrateLegacyLocalState({
      artifactpassConfigPath: fixture.artifactpassConfigPath,
      legacyConfigPath: fixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
      afterStage: (stage) => {
        if (stage === failedStage) throw new Error("injected failure");
      },
    })).rejects.toThrow("injected failure");

    expect(stores.artifactpass.size).toBe(0);
    await expect(readFile(fixture.artifactpassConfigPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(
      `${fixture.artifactpassConfigPath}.migration.json`,
      "utf8",
    ))).toMatchObject({ status: "rolled-back", stage: "rolled-back" });
    expect(await readFile(fixture.legacyConfigPath, "utf8")).toBe(fixture.legacyContents);
    },
  );

  it("recovers an interrupted operation before retrying with the same legacy source", async () => {
    const fixture = await legacyFixture();
    const stores = memoryStores();
    const token = `as_${"t".repeat(43)}`;
    stores.legacy.set("agent-token", token);
    stores.legacy.set("pdf-signing-key:artifactpass-primary", "signing-key");
    stores.artifactpass.set("agent-token", token);
    await mkdir(resolve(fixture.root, "artifactpass"), { recursive: true });
    await writeFile(fixture.artifactpassConfigPath, "incomplete");
    await writeFile(`${fixture.artifactpassConfigPath}.migration.json`, JSON.stringify({
      version: 1,
      operation_id: "interrupted-operation",
      status: "in-progress",
      stage: "credentials-staged",
      started_at: 1,
      legacy_config_path: fixture.legacyConfigPath,
      artifactpass_config_path: fixture.artifactpassConfigPath,
      created_credential_accounts: ["agent-token"],
      created_config: true,
    }));

    const result = await migrateLegacyLocalState({
      artifactpassConfigPath: fixture.artifactpassConfigPath,
      legacyConfigPath: fixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
    });

    expect(result.status).toBe("committed");
    expect(result.operationId).not.toBe("interrupted-operation");
    expect(stores.artifactpass.get("agent-token")).toBe(token);
    await expect(readLocalBridgeSettings(fixture.artifactpassConfigPath)).resolves.toMatchObject({
      active_profile: "production",
    });
  });

  it("serializes concurrent runs and recovers a stale lock", async () => {
    const fixture = await legacyFixture();
    const stores = memoryStores();
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => { releaseStarted = resolveStarted; });
    const first = migrateLegacyLocalState({
      artifactpassConfigPath: fixture.artifactpassConfigPath,
      legacyConfigPath: fixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
      afterStage: async (stage) => {
        if (stage === "started") await started;
      },
    });
    await vi.waitFor(async () => {
      await expect(stat(`${fixture.artifactpassConfigPath}.migration.lock`)).resolves.toBeDefined();
    });
    await expect(migrateLegacyLocalState({
      artifactpassConfigPath: fixture.artifactpassConfigPath,
      legacyConfigPath: fixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
    })).rejects.toThrow("already running");
    releaseStarted?.();
    await first;

    const staleFixture = await legacyFixture();
    const staleLock = `${staleFixture.artifactpassConfigPath}.migration.lock`;
    await mkdir(resolve(staleFixture.root, "artifactpass"), { recursive: true });
    await writeFile(staleLock, "stale");
    await utimes(staleLock, new Date(0), new Date(0));
    await expect(migrateLegacyLocalState({
      artifactpassConfigPath: staleFixture.artifactpassConfigPath,
      legacyConfigPath: staleFixture.legacyConfigPath,
      artifactpassCredentialStore: stores.artifactpassFactory,
      legacyCredentialStore: stores.legacyFactory,
      now: () => 10_000,
      staleLockMilliseconds: 1,
    })).resolves.toMatchObject({ status: "committed" });
  });
});
