import { rm } from "node:fs/promises";

import { runProcess, type ProcessRunner } from "../process";
import { validateSlackArchiveConfiguration, type SlackArchiveConfiguration } from "./configuration";

export interface SlackUninstallOptions {
  readonly statePath: string;
  readonly approved: boolean;
  readonly runner?: ProcessRunner;
}

export const uninstallSlackArchive = async (
  original: SlackArchiveConfiguration,
  options: SlackUninstallOptions,
): Promise<void> => {
  if (!options.approved) throw new Error("Approve deletion of this Slack archive's Worker, Queue, and D1 database first");
  const config = validateSlackArchiveConfiguration(original);
  const stem = `artifactpass-archive-${config.installation_id.slice(0, 8)}`;
  if (config.worker_name && config.worker_name !== stem ||
      config.queue_name && config.queue_name !== `${stem}-queue`) {
    throw new Error("The saved Cloudflare resource names do not belong to this Slack archive installation");
  }
  const runner = options.runner ?? runProcess;
  const environment = config.account_id ? { CLOUDFLARE_ACCOUNT_ID: config.account_id } : undefined;
  const removeIfPresent = async (args: string[], label: string, input?: string) => {
    try {
      await runner("wrangler", args, {
        ...(environment ? { env: environment } : {}),
        ...(input ? { input } : {}),
      });
    } catch (error) {
      if (error instanceof Error && /not found|does not exist|404/iu.test(error.message)) return;
      throw new Error(`Could not ${label}. Your saved setup was kept; check your Cloudflare connection and try again.`, { cause: error });
    }
  };
  if (config.queue_name && config.worker_name) {
    await removeIfPresent(["queues", "consumer", "worker", "remove", config.queue_name, config.worker_name], "detach the archive Worker from its Queue");
  }
  if (config.worker_name) await removeIfPresent(["delete", config.worker_name], "delete the archive Worker", "y\n");
  if (config.queue_name) await removeIfPresent(["queues", "delete", config.queue_name], "delete the archive Queue");
  if (config.database_id) await removeIfPresent(["d1", "delete", `${stem}-db`, "--skip-confirmation"], "delete the archive D1 database");
  await rm(options.statePath, { force: true });
};
