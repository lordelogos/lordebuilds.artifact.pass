import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { defaultLocalConfigPath } from "agent-bridge";

export interface PortableIntegration {
  readonly mcpConfig: string;
  readonly skillsDirectory: string;
}

const treeDigest = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
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
      hash.update(relative(root, path));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  };
  await visit(root);
  return hash.digest("hex");
};

export const defaultPortableIntegrationDirectory = (
  configPath = defaultLocalConfigPath(),
): string => resolve(dirname(configPath), "portable-integration");

export const installPortableIntegration = async (options: {
  readonly sourceRoot: string;
  readonly destinationDirectory?: string;
}): Promise<PortableIntegration> => {
  const sourceRoot = resolve(options.sourceRoot);
  const sourceStats = await stat(sourceRoot);
  if (!sourceStats.isDirectory()) throw new Error("Portable integration source must be a directory");

  const digest = await treeDigest(sourceRoot);
  const destinationDirectory = resolve(
    options.destinationDirectory ?? defaultPortableIntegrationDirectory(),
  );
  const targetRoot = join(destinationDirectory, digest);
  const pluginRoot = join(targetRoot, "plugin");
  const mcpConfig = join(targetRoot, "mcp.json");
  const skillsDirectory = join(pluginRoot, "skills");
  const bridgePath = join(pluginRoot, "dist", "cli.mjs");

  const verify = async (): Promise<void> => {
    const [installedDigest, bridgeStats, skillsStats, mcpConfigStats] = await Promise.all([
      treeDigest(pluginRoot),
      stat(bridgePath),
      stat(skillsDirectory),
      stat(mcpConfig),
    ]);
    if (
      installedDigest !== digest ||
      !bridgeStats.isFile() ||
      !skillsStats.isDirectory() ||
      !mcpConfigStats.isFile()
    ) {
      throw new Error("Installed portable integration failed verification");
    }
  };

  try {
    await verify();
    return { mcpConfig, skillsDirectory };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === undefined) throw error;
  }

  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporaryRoot = join(destinationDirectory, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(temporaryRoot, { mode: 0o700 });
    await cp(sourceRoot, join(temporaryRoot, "plugin"), { recursive: true, errorOnExist: true });
    const temporaryBridgePath = join(temporaryRoot, "plugin", "dist", "cli.mjs");
    await writeFile(join(temporaryRoot, "mcp.json"), `${JSON.stringify({
      mcpServers: {
        artifactpass: {
          command: process.execPath,
          args: [temporaryBridgePath.replace(temporaryRoot, targetRoot)],
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporaryRoot, targetRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    await verify();
    return { mcpConfig, skillsDirectory };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
};
