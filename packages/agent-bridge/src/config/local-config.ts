import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface LocalBridgeProfileSettings {
  readonly base_url: string;
  readonly workspace_roots: readonly string[];
  readonly open_development?: true;
  readonly pdf_key_id?: string;
  readonly publication_state?: "legacy";
}

export interface LocalBridgeSettings {
  readonly version: 2;
  readonly active_profile: string;
  readonly profiles: Readonly<Record<string, LocalBridgeProfileSettings>>;
}

interface LegacyLocalBridgeSettings extends LocalBridgeProfileSettings {
  readonly version: 1;
}

const profileNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const validateProfileName = (name: string): string => {
  if (!profileNamePattern.test(name)) {
    throw new Error("Artifact Share profile names use 1-32 lowercase letters, numbers, or hyphens");
  }
  return name;
};

const validateProfile = (value: unknown): LocalBridgeProfileSettings => {
  if (!isRecord(value)) {
    throw new Error("Artifact Share profile must contain a JSON object");
  }
  const candidate = value;
  if (typeof candidate.base_url !== "string") {
    throw new Error("Artifact Share profile requires a base URL");
  }
  if (
    !Array.isArray(candidate.workspace_roots) ||
    candidate.workspace_roots.length === 0 ||
    !candidate.workspace_roots.every((root) => typeof root === "string" && resolve(root) === root)
  ) {
    throw new Error("Artifact Share config requires absolute workspace roots");
  }
  if (candidate.open_development !== undefined && candidate.open_development !== true) {
    throw new Error("Artifact Share config open_development must be true when enabled");
  }
  if (
    candidate.pdf_key_id !== undefined &&
    (typeof candidate.pdf_key_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(candidate.pdf_key_id))
  ) {
    throw new Error("Artifact Share config contains an invalid PDF signing key ID");
  }
  if (candidate.publication_state !== undefined && candidate.publication_state !== "legacy") {
    throw new Error("Artifact Share config contains an invalid publication state mode");
  }
  return {
    base_url: candidate.base_url,
    workspace_roots: candidate.workspace_roots as string[],
    ...(candidate.open_development === true ? { open_development: true } : {}),
    ...(typeof candidate.pdf_key_id === "string" ? { pdf_key_id: candidate.pdf_key_id } : {}),
    ...(candidate.publication_state === "legacy" ? { publication_state: "legacy" } : {}),
  };
};

const validateSettings = (value: unknown): LocalBridgeSettings => {
  if (!isRecord(value)) throw new Error("Artifact Share config must contain a JSON object");
  if (value.version === 1) {
    const profile = validateProfile(value);
    const name = profile.open_development === true ? "local" : "production";
    return {
      version: 2,
      active_profile: name,
      profiles: { [name]: { ...profile, publication_state: "legacy" } },
    };
  }
  if (value.version !== 2 || typeof value.active_profile !== "string" || !isRecord(value.profiles)) {
    throw new Error("Artifact Share config has an unsupported format");
  }
  const entries = Object.entries(value.profiles);
  if (entries.length === 0) throw new Error("Artifact Share config requires at least one profile");
  const profiles = Object.fromEntries(entries.map(([name, profile]) => [
    validateProfileName(name),
    validateProfile(profile),
  ]));
  validateProfileName(value.active_profile);
  if (!Object.hasOwn(profiles, value.active_profile)) {
    throw new Error(`Unknown Artifact Share profile: ${value.active_profile}`);
  }
  return { version: 2, active_profile: value.active_profile, profiles };
};

export const selectLocalBridgeProfile = (
  settings: LocalBridgeSettings,
  requestedProfile?: string,
): { readonly name: string; readonly settings: LocalBridgeProfileSettings } => {
  const name = validateProfileName(requestedProfile ?? settings.active_profile);
  if (!Object.hasOwn(settings.profiles, name)) throw new Error(`Unknown Artifact Share profile: ${name}`);
  const profile = settings.profiles[name];
  if (profile === undefined) throw new Error(`Unknown Artifact Share profile: ${name}`);
  return { name, settings: profile };
};

export const publicationStatePathForProfile = (configPath: string, profileName: string): string =>
  `${configPath}.${validateProfileName(profileName)}.publication-state`;

export const upsertLocalBridgeProfile = (
  settings: LocalBridgeSettings | null,
  nameValue: string,
  profileValue: LocalBridgeProfileSettings,
): LocalBridgeSettings => {
  const name = validateProfileName(nameValue);
  const profile = validateProfile(profileValue);
  return validateSettings({
    version: 2,
    active_profile: name,
    profiles: { ...settings?.profiles, [name]: profile },
  });
};

export const setActiveLocalBridgeProfile = (
  settings: LocalBridgeSettings,
  nameValue: string,
): LocalBridgeSettings => validateSettings({
  ...settings,
  active_profile: validateProfileName(nameValue),
});

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
  settings: LocalBridgeSettings | LegacyLocalBridgeSettings,
): Promise<void> => {
  const validated = validateSettings(settings);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};
