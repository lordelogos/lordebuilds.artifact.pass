import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface LocalBridgeSettings {
  readonly version: 1;
  readonly base_url: string;
  readonly workspace_roots: readonly string[];
}

const validateSettings = (value: unknown): LocalBridgeSettings => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact Share config must contain a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.base_url !== "string") {
    throw new Error("Artifact Share config has an unsupported format");
  }
  if (
    !Array.isArray(candidate.workspace_roots) ||
    candidate.workspace_roots.length === 0 ||
    !candidate.workspace_roots.every((root) => typeof root === "string" && resolve(root) === root)
  ) {
    throw new Error("Artifact Share config requires absolute workspace roots");
  }
  return {
    version: 1,
    base_url: candidate.base_url,
    workspace_roots: candidate.workspace_roots as string[],
  };
};

export const defaultLocalConfigPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  const explicit = environment.ARTIFACT_SHARE_CONFIG_PATH;
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  if (platform === "win32") {
    const applicationData = environment.APPDATA;
    if (applicationData === undefined || applicationData.length === 0) {
      throw new Error("APPDATA is required to locate Artifact Share config");
    }
    return resolve(applicationData, "lordebuilds.artifacts.share", "config.json");
  }
  const configurationHome = environment.XDG_CONFIG_HOME;
  return resolve(
    configurationHome === undefined || configurationHome.length === 0
      ? resolve(homedir(), ".config")
      : configurationHome,
    "lordebuilds.artifacts.share",
    "config.json",
  );
};

const parseSettings = (contents: string): LocalBridgeSettings => {
  if (Buffer.byteLength(contents) > 16 * 1024) throw new Error("Artifact Share config is too large");
  return validateSettings(JSON.parse(contents));
};

export const readLocalBridgeSettingsSync = (path: string): LocalBridgeSettings =>
  parseSettings(readFileSync(path, "utf8"));

export const readLocalBridgeSettings = async (path: string): Promise<LocalBridgeSettings> =>
  parseSettings(await readFile(path, "utf8"));

export const writeLocalBridgeSettings = async (
  path: string,
  settings: LocalBridgeSettings,
): Promise<void> => {
  const validated = validateSettings(settings);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};
