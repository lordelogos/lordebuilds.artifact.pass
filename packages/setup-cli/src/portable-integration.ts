import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { defaultLocalConfigPath } from "agent-bridge";

export interface PortableIntegration {
  readonly digest: string;
  readonly rootDirectory: string;
  readonly marketplaceDirectory: string;
  readonly mcpConfig: string;
  readonly skillsDirectory: string;
}

const createdIntegrations = new WeakSet<PortableIntegration>();

export const portableIntegrationWasCreated = (portable: PortableIntegration): boolean =>
  createdIntegrations.has(portable);

const updateDirectoryDigest = async (
  hash: ReturnType<typeof createHash>,
  root: string,
  prefix = "",
): Promise<void> => {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Portable integration cannot contain symbolic links");
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error("Portable integration contains an unsupported filesystem entry");
      hash.update(join(prefix, relative(root, path)));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  };
  await visit(root);
};

export const portableIntegrationDigest = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  await updateDirectoryDigest(hash, root);
  return hash.digest("hex");
};

const marketplaceDigest = async (marketplaceSource: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const path of [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
  ]) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(marketplaceSource, path)));
    hash.update("\0");
  }
  await updateDirectoryDigest(
    hash,
    join(marketplaceSource, "plugins", "artifactpass"),
    join("plugins", "artifactpass"),
  );
  return hash.digest("hex");
};

export const defaultPortableIntegrationDirectory = (
  configPath = defaultLocalConfigPath(),
): string => resolve(dirname(configPath), "portable-integration");

export const installPortableIntegration = async (options: {
  readonly marketplaceSource: string;
  readonly destinationDirectory?: string;
}): Promise<PortableIntegration> => {
  const marketplaceSource = resolve(options.marketplaceSource);
  const sourceStats = await stat(marketplaceSource);
  if (!sourceStats.isDirectory()) throw new Error("Portable marketplace source must be a directory");

  const digest = await marketplaceDigest(marketplaceSource);
  const destinationDirectory = resolve(
    options.destinationDirectory ?? defaultPortableIntegrationDirectory(),
  );
  const targetRoot = join(destinationDirectory, digest);
  const marketplaceDirectory = join(targetRoot, "marketplace");
  const pluginRoot = join(marketplaceDirectory, "plugins", "artifactpass");
  const mcpConfig = join(targetRoot, "mcp.json");
  const skillsDirectory = join(pluginRoot, "skills");
  const bridgePath = join(pluginRoot, "dist", "cli.mjs");
  const claudeMarketplace = join(marketplaceDirectory, ".claude-plugin", "marketplace.json");
  const codexMarketplace = join(marketplaceDirectory, ".agents", "plugins", "marketplace.json");

  const verify = async (): Promise<void> => {
    const [installedDigest, bridgeStats, skillsStats, mcpConfigStats, claudeStats, codexStats] = await Promise.all([
      marketplaceDigest(marketplaceDirectory),
      stat(bridgePath),
      stat(skillsDirectory),
      stat(mcpConfig),
      stat(claudeMarketplace),
      stat(codexMarketplace),
    ]);
    if (
      installedDigest !== digest ||
      !bridgeStats.isFile() ||
      !skillsStats.isDirectory() ||
      !mcpConfigStats.isFile() ||
      !claudeStats.isFile() ||
      !codexStats.isFile()
    ) {
      throw new Error("Installed portable integration failed verification");
    }
  };

  try {
    await verify();
    return { digest, rootDirectory: targetRoot, marketplaceDirectory, mcpConfig, skillsDirectory };
  } catch {
    await rm(targetRoot, { recursive: true, force: true });
  }

  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporaryRoot = join(destinationDirectory, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(temporaryRoot, { mode: 0o700 });
    const temporaryMarketplace = join(temporaryRoot, "marketplace");
    await Promise.all([
      mkdir(join(temporaryMarketplace, ".agents", "plugins"), { recursive: true }),
      mkdir(join(temporaryMarketplace, ".claude-plugin"), { recursive: true }),
      mkdir(join(temporaryMarketplace, "plugins"), { recursive: true }),
    ]);
    await Promise.all([
      cp(
        join(marketplaceSource, ".agents", "plugins", "marketplace.json"),
        join(temporaryMarketplace, ".agents", "plugins", "marketplace.json"),
      ),
      cp(
        join(marketplaceSource, ".claude-plugin", "marketplace.json"),
        join(temporaryMarketplace, ".claude-plugin", "marketplace.json"),
      ),
      cp(
        join(marketplaceSource, "plugins", "artifactpass"),
        join(temporaryMarketplace, "plugins", "artifactpass"),
        { recursive: true, errorOnExist: true },
      ),
    ]);
    const temporaryBridgePath = join(
      temporaryRoot,
      "marketplace",
      "plugins",
      "artifactpass",
      "dist",
      "cli.mjs",
    );
    await writeFile(join(temporaryRoot, "mcp.json"), `${JSON.stringify({
      mcpServers: {
        artifactpass: {
          command: process.execPath,
          args: [temporaryBridgePath.replace(temporaryRoot, targetRoot)],
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    let created = true;
    try {
      await rename(temporaryRoot, targetRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await rm(temporaryRoot, { recursive: true, force: true });
      created = false;
    }
    await verify();
    const portable = {
      digest,
      rootDirectory: targetRoot,
      marketplaceDirectory,
      mcpConfig,
      skillsDirectory,
    };
    if (created) createdIntegrations.add(portable);
    return portable;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
};
