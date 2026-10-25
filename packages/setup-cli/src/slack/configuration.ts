import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SlackArchiveStage = "prepared" | "worker-deployed" | "manifest-pending" | "ready";

export interface SlackArchiveConfiguration {
  readonly schema_version: 1;
  readonly installation_id: string;
  readonly stage: SlackArchiveStage;
  readonly created_at: string;
  readonly updated_at: string;
  readonly sources: readonly string[];
  readonly enabled_channels: readonly string[];
  readonly paused: boolean;
  readonly account_id?: string;
  readonly database_id?: string;
  readonly queue_name?: string;
  readonly worker_name?: string;
  readonly worker_url?: string;
  readonly team_id?: string;
  readonly app_id?: string;
  readonly manifest_applied_for?: string;
  readonly verified_at?: string | undefined;
}

const allowedFields = new Set([
  "schema_version", "installation_id", "stage", "created_at", "updated_at", "sources",
  "enabled_channels", "account_id", "database_id", "queue_name", "worker_name",
  "worker_url", "team_id", "app_id", "manifest_applied_for", "verified_at", "paused",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const canonicalSlackSource = (raw: string): string => {
  const candidate = raw.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter an HTTPS ArtifactPass origin, such as https://artifacts.example.com");
  }
  if (url.protocol !== "https:" || (candidate !== url.origin && candidate !== `${url.origin}/`) || url.username || url.password ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(url.hostname)) {
    throw new Error("Enter an HTTPS ArtifactPass origin without a path, such as https://artifacts.example.com");
  }
  return url.origin;
};

export const createSlackArchiveConfiguration = (): SlackArchiveConfiguration => {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    installation_id: randomUUID(),
    stage: "prepared",
    created_at: now,
    updated_at: now,
    sources: ["https://artifactpass.com"],
    enabled_channels: [],
    paused: false,
  };
};

const withSources = (config: SlackArchiveConfiguration, sources: readonly string[]): SlackArchiveConfiguration => ({
  ...config,
  sources,
  stage: config.stage === "prepared" ? "prepared" : "manifest-pending",
  verified_at: undefined,
  updated_at: new Date().toISOString(),
});

export const addSlackSource = (config: SlackArchiveConfiguration, raw: string): SlackArchiveConfiguration => {
  const origin = canonicalSlackSource(raw);
  if (config.sources.includes(origin)) return config;
  if (config.sources.length >= 5) throw new Error("A Slack app can watch at most five source domains");
  return withSources(config, [...config.sources, origin]);
};

export const removeSlackSource = (config: SlackArchiveConfiguration, raw: string): SlackArchiveConfiguration => {
  const origin = canonicalSlackSource(raw);
  if (!config.sources.includes(origin)) throw new Error("That source is not configured");
  if (config.sources.length === 1) throw new Error("Keep at least one ArtifactPass source");
  return withSources(config, config.sources.filter(item => item !== origin));
};

export const slackChannelId = (raw: string): string => {
  const input = raw.trim();
  if (/^[CG][A-Z0-9]{8,}$/u.test(input)) return input;
  try {
    const url = new URL(input);
    const match = /^\/archives\/([CG][A-Z0-9]{8,})(?:\/|$)/u.exec(url.pathname);
    if (url.protocol === "https:" && /(?:^|\.)slack\.com$/u.test(url.hostname) && match?.[1]) return match[1];
  } catch { /* An ID is also accepted. */ }
  throw new Error("Enter a Slack channel ID or link, such as https://example.slack.com/archives/C1234567890");
};

export const addSlackChannel = (config: SlackArchiveConfiguration, ...raws: readonly string[]): SlackArchiveConfiguration => {
  if (raws.length === 0) throw new Error("Enter at least one Slack channel ID or link");
  const ids = raws.map(slackChannelId);
  const enabled = [...new Set([...config.enabled_channels, ...ids])];
  if (enabled.length === config.enabled_channels.length) return config;
  return {
    ...config, enabled_channels: enabled,
    stage: config.stage === "ready" ? "worker-deployed" : config.stage,
    verified_at: undefined, updated_at: new Date().toISOString(),
  };
};

export const removeSlackChannel = (config: SlackArchiveConfiguration, raw: string): SlackArchiveConfiguration => {
  const id = slackChannelId(raw);
  if (!config.enabled_channels.includes(id)) throw new Error("That channel is not enabled");
  return { ...config, enabled_channels: config.enabled_channels.filter(item => item !== id), updated_at: new Date().toISOString() };
};

export const validateSlackArchiveConfiguration = (value: unknown): SlackArchiveConfiguration => {
  if (!isRecord(value) || Object.keys(value).some(key => !allowedFields.has(key))) {
    throw new Error("Slack setup state must contain non-secret fields only");
  }
  if (value.schema_version !== 1 || typeof value.installation_id !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(value.installation_id) ||
      !["prepared", "worker-deployed", "manifest-pending", "ready"].includes(String(value.stage)) ||
      typeof value.paused !== "boolean" ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at)) ||
      !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 5 ||
      !value.sources.every(item => typeof item === "string" && canonicalSlackSource(item) === item) ||
      new Set(value.sources).size !== value.sources.length ||
      !Array.isArray(value.enabled_channels) ||
      !value.enabled_channels.every(item => typeof item === "string" && /^[CG][A-Z0-9]{8,}$/u.test(item)) ||
      new Set(value.enabled_channels).size !== value.enabled_channels.length) {
    throw new Error("Slack setup state is invalid");
  }
  for (const field of ["account_id", "database_id", "queue_name", "worker_name", "worker_url", "team_id", "app_id", "verified_at"]) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0)) {
      throw new Error("Slack setup state is invalid");
    }
  }
  if (value.manifest_applied_for !== undefined &&
      (typeof value.manifest_applied_for !== "string" || !/^[a-f0-9]{64}$/u.test(value.manifest_applied_for))) {
    throw new Error("Slack setup state is invalid");
  }
  return value as unknown as SlackArchiveConfiguration;
};

export const readSlackArchiveConfiguration = async (path: string): Promise<SlackArchiveConfiguration | null> => {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (source.length > 32 * 1024) throw new Error("Slack setup state is too large");
  return validateSlackArchiveConfiguration(JSON.parse(source));
};

export const writeSlackArchiveConfiguration = async (path: string, value: SlackArchiveConfiguration): Promise<void> => {
  const config = validateSlackArchiveConfiguration(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true });
    throw error;
  }
};
