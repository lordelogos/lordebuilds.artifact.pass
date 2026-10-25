import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runProcess, type ProcessRunner } from "../process";
import { validateSlackArchiveConfiguration, writeSlackArchiveConfiguration, type SlackArchiveConfiguration } from "./configuration";

interface D1DatabaseSummary {
  readonly name: string;
  readonly uuid: string;
}

export interface SlackProvisionOptions {
  readonly accountId: string;
  readonly statePath: string;
  readonly deploymentRoot: string;
  readonly runner?: ProcessRunner;
  readonly approved: boolean;
}

const accountIdPattern = /^[a-f0-9]{32}$/u;
const databaseIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const workersUrlPattern = /https:\/\/[a-z0-9.-]+\.workers\.dev/iu;

const readDatabases = async (runner: ProcessRunner, environment: Record<string, string>): Promise<D1DatabaseSummary[]> => {
  const result = await runner("wrangler", ["d1", "list", "--json"], { env: environment });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Cloudflare returned an unreadable D1 database list");
  }
  if (!Array.isArray(parsed) || !parsed.every(item =>
    typeof item === "object" && item !== null &&
    "name" in item && typeof item.name === "string" &&
    "uuid" in item && typeof item.uuid === "string")) {
    throw new Error("Cloudflare returned an unexpected D1 database list");
  }
  return parsed as D1DatabaseSummary[];
};

const workerConfiguration = (config: SlackArchiveConfiguration, deploymentRoot: string) => {
  if (!config.account_id || !config.database_id || !config.queue_name || !config.worker_name) {
    throw new Error("Cloudflare resources are not ready for deployment");
  }
  return {
    name: config.worker_name,
    main: join(deploymentRoot, "index.js"),
    account_id: config.account_id,
    compatibility_date: "2026-01-01",
    workers_dev: true,
    d1_databases: [{ binding: "ARCHIVE_DB", database_name: `${config.worker_name}-db`, database_id: config.database_id }],
    queues: {
      producers: [{ binding: "ARCHIVE_QUEUE", queue: config.queue_name }],
      consumers: [{ queue: config.queue_name, max_batch_size: 1, max_retries: 3 }],
    },
    vars: {
      APPROVED_ORIGINS: JSON.stringify(config.sources),
      ENABLED_CHANNEL_IDS: JSON.stringify(config.paused ? [] : config.enabled_channels),
      SLACK_TEAM_ID: config.team_id ?? "",
      SLACK_APP_ID: config.app_id ?? "",
    },
  };
};

export const provisionSlackResources = async (
  original: SlackArchiveConfiguration,
  options: SlackProvisionOptions,
): Promise<SlackArchiveConfiguration> => {
  if (!options.approved) throw new Error("Approve the customer-owned Worker, Queue, and D1 creation first");
  if (!accountIdPattern.test(options.accountId)) throw new Error("Choose a valid Cloudflare account ID");
  const config = validateSlackArchiveConfiguration(original);
  if (config.account_id && config.account_id !== options.accountId) {
    throw new Error("This Slack archive belongs to a different Cloudflare account");
  }
  await access(join(options.deploymentRoot, "index.js"));
  await access(join(options.deploymentRoot, "0001-deliveries.sql"));
  const runner = options.runner ?? runProcess;
  const environment = { CLOUDFLARE_ACCOUNT_ID: options.accountId };
  const stem = `artifactpass-archive-${config.installation_id.slice(0, 8)}`;
  const resourceNames = {
    ...config,
    account_id: options.accountId,
    queue_name: config.queue_name ?? `${stem}-queue`,
    worker_name: config.worker_name ?? stem,
  };
  await writeSlackArchiveConfiguration(options.statePath, resourceNames);

  try {
    await runner("wrangler", ["queues", "info", resourceNames.queue_name], { env: environment });
  } catch (error) {
    if (!(error instanceof Error) || !/not found|does not exist|404/iu.test(error.message)) throw error;
    await runner("wrangler", ["queues", "create", resourceNames.queue_name], { env: environment });
  }

  const databaseName = `${resourceNames.worker_name}-db`;
  let database = (await readDatabases(runner, environment)).find(item => item.name === databaseName);
  if (!database) {
    await runner("wrangler", ["d1", "create", databaseName], { env: environment });
    database = (await readDatabases(runner, environment)).find(item => item.name === databaseName);
  }
  if (!database || !databaseIdPattern.test(database.uuid)) {
    throw new Error("The new D1 database was not found in the selected Cloudflare account");
  }
  const withDatabase = { ...resourceNames, database_id: database.uuid };
  await writeSlackArchiveConfiguration(options.statePath, withDatabase);

  const configPath = join(dirname(options.statePath), "wrangler-slack-archive.json");
  await writeFile(configPath, `${JSON.stringify(workerConfiguration(withDatabase, options.deploymentRoot), null, 2)}\n`, { mode: 0o600 });
  await runner("wrangler", ["d1", "execute", databaseName, "--remote", "--file",
    join(options.deploymentRoot, "0001-deliveries.sql"), "--yes", "--config", configPath], { env: environment });
  // Dashboard secret updates create a new remote Worker version. Wrangler preserves those
  // secrets, but --strict rejects the expected remote difference on activation and resume.
  const deployed = await runner("wrangler", ["deploy", "--config", configPath], { env: environment });
  const workerUrl = workersUrlPattern.exec(`${deployed.stdout}\n${deployed.stderr}`)?.[0];
  if (!workerUrl) throw new Error("The Worker deployed, but its workers.dev URL was not reported; inspect the Cloudflare dashboard before continuing");
  const complete: SlackArchiveConfiguration = {
    ...withDatabase,
    stage: withDatabase.stage === "prepared" ? "worker-deployed" : withDatabase.stage,
    worker_url: workerUrl,
    updated_at: new Date().toISOString(),
  };
  await writeSlackArchiveConfiguration(options.statePath, complete);
  return complete;
};
