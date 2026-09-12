import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";

export type ProjectAgentHost = "gemini" | "kimi" | "cursor" | "vscode" | "antigravity";

interface ProjectHostInstallation {
  rollback(): Promise<void>;
}

interface HostDefinition {
  readonly label: string;
  readonly configPath: string;
  readonly skillsPath: string;
  readonly collection: "mcpServers" | "servers";
  readonly includeTransportType?: boolean;
}

const hostDefinitions: Readonly<Record<ProjectAgentHost, HostDefinition>> = {
  gemini: {
    label: "Gemini CLI",
    configPath: ".gemini/settings.json",
    skillsPath: ".gemini/skills",
    collection: "mcpServers",
  },
  kimi: {
    label: "Kimi Code",
    configPath: ".kimi-code/mcp.json",
    skillsPath: ".kimi-code/skills",
    collection: "mcpServers",
  },
  cursor: {
    label: "Cursor",
    configPath: ".cursor/mcp.json",
    skillsPath: ".cursor/skills",
    collection: "mcpServers",
  },
  vscode: {
    label: "VS Code / GitHub Copilot",
    configPath: ".vscode/mcp.json",
    skillsPath: ".github/skills",
    collection: "servers",
    includeTransportType: true,
  },
  antigravity: {
    label: "Antigravity",
    configPath: ".agents/mcp_config.json",
    skillsPath: ".agents/skills",
    collection: "mcpServers",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertNoSymlinks = async (workspaceRoot: string, targets: readonly string[]): Promise<void> => {
  for (const target of targets) {
    const targetRelativePath = relative(workspaceRoot, target);
    if (targetRelativePath.startsWith(`..${sep}`) || targetRelativePath === "..") {
      throw new Error("Agent configuration path escapes the selected workspace");
    }
    let current = workspaceRoot;
    for (const segment of targetRelativePath.split(sep)) {
      current = join(current, segment);
      const metadata = await lstat(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (metadata?.isSymbolicLink() === true) {
        throw new Error("Agent configuration paths cannot contain symbolic links");
      }
    }
  }
};

interface FileSnapshot {
  readonly path: string;
  readonly bytes: Buffer | null;
}

const snapshotFile = async (path: string): Promise<FileSnapshot> => ({
  path,
  bytes: await readFile(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }),
});

const restoreFile = async (snapshot: FileSnapshot): Promise<void> => {
  if (snapshot.bytes === null) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await mkdir(dirname(snapshot.path), { recursive: true });
  await writeFile(snapshot.path, snapshot.bytes);
};

const sourceFiles = async (root: string, prefix = ""): Promise<readonly string[]> => {
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) return sourceFiles(root, relativePath);
    if (!entry.isFile()) throw new Error("ArtifactPass skills cannot contain symbolic links");
    return [relativePath];
  }));
  return nested.flat();
};

export const installProjectHost = async (
  host: ProjectAgentHost,
  workspaceRoot: string,
  marketplaceSource: string,
): Promise<ProjectHostInstallation> => {
  const definition = hostDefinitions[host];
  const pluginRoot = join(marketplaceSource, "plugins", "artifactpass");
  const bridgePath = join(pluginRoot, "dist", "cli.mjs");
  const sourceSkills = join(pluginRoot, "skills");
  const configPath = join(workspaceRoot, definition.configPath);
  const skillsRoot = join(workspaceRoot, definition.skillsPath);
  const skillFiles = await sourceFiles(sourceSkills);
  const targetSkillFiles = skillFiles.map((relativePath) => join(skillsRoot, relativePath));
  await assertNoSymlinks(workspaceRoot, [configPath, ...targetSkillFiles]);
  const sourceSkillBytes = await Promise.all(skillFiles.map((relativePath) =>
    readFile(join(sourceSkills, relativePath))));
  const fileSnapshots = await Promise.all([
    snapshotFile(configPath),
    ...targetSkillFiles.map(snapshotFile),
  ]);
  const directories = [...new Set([
    dirname(configPath),
    dirname(skillsRoot),
    skillsRoot,
    ...targetSkillFiles.map(dirname),
  ])].sort((left, right) => left.length - right.length);
  const createdDirectories: string[] = [];

  const rollback = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const snapshot of [...fileSnapshots].reverse()) {
      await restoreFile(snapshot).catch((error: unknown) => errors.push(error));
    }
    for (const directory of [...createdDirectories].reverse()) {
      await rmdir(directory).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") errors.push(error);
      });
    }
    if (errors.length > 0) throw new AggregateError(errors, `${definition.label} rollback was incomplete`);
  };

  try {
    for (const directory of directories) {
      try {
        await mkdir(directory);
        createdDirectories.push(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    const priorBytes = fileSnapshots[0]?.bytes;
    const configText = priorBytes?.toString("utf8") ?? "{}\n";
    const parseErrors: ParseError[] = [];
    const parsed: unknown = parse(configText, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0 || !isRecord(parsed)) {
      throw new Error(`${definition.label} MCP configuration is not valid JSON`);
    }
    const config = parsed;
    const currentCollection = config[definition.collection];
    if (currentCollection !== undefined && !isRecord(currentCollection)) {
      throw new Error(`${definition.label} MCP configuration has an invalid ${definition.collection} value`);
    }
    const server = {
      ...(definition.includeTransportType === true ? { type: "stdio" } : {}),
      command: process.execPath,
      args: [bridgePath],
    };
    const updatedConfig = applyEdits(configText, modify(
      configText,
      [definition.collection, "artifactpass"],
      server,
      { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } },
    ));
    const normalizedConfig = updatedConfig.endsWith("\n") ? updatedConfig : `${updatedConfig}\n`;
    if (priorBytes?.equals(Buffer.from(normalizedConfig)) !== true) {
      await writeFile(configPath, normalizedConfig);
    }
    await Promise.all(sourceSkillBytes.map(async (bytes, index) => {
      if (fileSnapshots[index + 1]?.bytes?.equals(bytes) === true) return;
      await writeFile(targetSkillFiles[index] as string, bytes);
    }));
    return { rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `${definition.label} installation failed and rollback was incomplete`);
    }
    throw error;
  }
};
