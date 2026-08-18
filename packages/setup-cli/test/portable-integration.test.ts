import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { installPortableIntegration } from "../src/portable-integration";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryDirectories: string[] = [];

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
    const sourceRoot = join(root, "source");
    await cp(resolve(repositoryRoot, "plugins/artifactpass"), sourceRoot, { recursive: true });

    const installed = await installPortableIntegration({
      sourceRoot,
      destinationDirectory: join(root, "user-data"),
    });
    await rm(sourceRoot, { recursive: true, force: true });

    expect(installed.mcpConfig).toMatch(/^\//u);
    expect(installed.skillsDirectory).toMatch(/^\//u);
    expect((await stat(installed.skillsDirectory)).isDirectory()).toBe(true);
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
    const sourceRoot = resolve(repositoryRoot, "plugins/artifactpass");
    const destinationDirectory = join(root, "user-data");

    const first = await installPortableIntegration({ sourceRoot, destinationDirectory });
    const second = await installPortableIntegration({ sourceRoot, destinationDirectory });

    expect(second).toEqual(first);
  });
});
