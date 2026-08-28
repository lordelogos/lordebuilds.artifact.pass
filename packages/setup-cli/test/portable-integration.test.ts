import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  installPortableIntegration,
  portableIntegrationWasCreated,
} from "../src/portable-integration";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryDirectories: string[] = [];

const createMarketplaceFixture = async (root: string): Promise<string> => {
  const marketplaceSource = join(root, "source-marketplace");
  await Promise.all([
    mkdir(join(marketplaceSource, ".agents/plugins"), { recursive: true }),
    mkdir(join(marketplaceSource, ".claude-plugin"), { recursive: true }),
    mkdir(join(marketplaceSource, "plugins"), { recursive: true }),
  ]);
  await Promise.all([
    cp(
      resolve(repositoryRoot, ".agents/plugins/marketplace.json"),
      join(marketplaceSource, ".agents/plugins/marketplace.json"),
    ),
    cp(
      resolve(repositoryRoot, ".claude-plugin/marketplace.json"),
      join(marketplaceSource, ".claude-plugin/marketplace.json"),
    ),
    cp(
      resolve(repositoryRoot, "plugins/artifactpass"),
      join(marketplaceSource, "plugins/artifactpass"),
      { recursive: true },
    ),
  ]);
  return marketplaceSource;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("portable integration installation", () => {
  it("survives removal of its package source and exposes absolute MCP and skills paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-portable-"));
    temporaryDirectories.push(root);
    const marketplaceSource = await createMarketplaceFixture(root);

    const installed = await installPortableIntegration({
      marketplaceSource,
      destinationDirectory: join(root, "user-data"),
    });
    await rm(marketplaceSource, { recursive: true, force: true });

    expect(installed.mcpConfig).toMatch(/^\//u);
    expect(installed.skillsDirectory).toMatch(/^\//u);
    expect(installed.marketplaceDirectory).toMatch(/^\//u);
    expect(installed.rootDirectory).toMatch(/^\//u);
    expect(installed.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(installed.skillsDirectory)).isDirectory()).toBe(true);
    expect((await stat(join(
      installed.marketplaceDirectory,
      ".claude-plugin/marketplace.json",
    ))).isFile()).toBe(true);
    expect((await stat(join(
      installed.marketplaceDirectory,
      ".agents/plugins/marketplace.json",
    ))).isFile()).toBe(true);
    const configuration = JSON.parse(await readFile(installed.mcpConfig, "utf8")) as {
      readonly mcpServers: { readonly artifactpass: { readonly args: readonly string[] } };
    };
    const bridgePath = configuration.mcpServers.artifactpass.args[0];
    expect(bridgePath).toMatch(/^\//u);
    expect((await stat(bridgePath ?? "")).isFile()).toBe(true);
  });

  it("reuses an already verified content-addressed installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-portable-"));
    temporaryDirectories.push(root);
    const marketplaceSource = await createMarketplaceFixture(root);
    const destinationDirectory = join(root, "user-data");

    const first = await installPortableIntegration({ marketplaceSource, destinationDirectory });
    const second = await installPortableIntegration({ marketplaceSource, destinationDirectory });

    expect(second).toEqual(first);
    expect(portableIntegrationWasCreated(first)).toBe(true);
    expect(portableIntegrationWasCreated(second)).toBe(false);
  });

  it("repairs a corrupted content-addressed installation without duplicating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifactpass-portable-repair-"));
    temporaryDirectories.push(root);
    const marketplaceSource = await createMarketplaceFixture(root);
    const destinationDirectory = join(root, "user-data");
    const first = await installPortableIntegration({ marketplaceSource, destinationDirectory });
    const bridgePath = join(
      first.marketplaceDirectory,
      "plugins",
      "artifactpass",
      "dist",
      "cli.mjs",
    );
    const expectedBridge = await readFile(resolve(
      marketplaceSource,
      "plugins/artifactpass/dist/cli.mjs",
    ));
    await writeFile(bridgePath, "corrupt");

    const repaired = await installPortableIntegration({ marketplaceSource, destinationDirectory });

    expect(repaired).toEqual(first);
    expect(await readFile(bridgePath)).toEqual(expectedBridge);
  }, 15_000);
});
