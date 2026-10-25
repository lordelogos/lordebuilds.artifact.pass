import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runProcess, type ProcessRunner } from "../process";
import { validateSlackArchiveConfiguration, writeSlackArchiveConfiguration, type SlackArchiveConfiguration } from "./configuration";
import { provisionSlackResources } from "./deployment";
import { createSlackAppManifest } from "./manifest";

export interface SlackActivationOptions {
  readonly statePath: string;
  readonly deploymentRoot: string;
  readonly teamId: string;
  readonly appId: string;
  readonly runner?: ProcessRunner;
}

export const activateSlackArchive = async (
  original: SlackArchiveConfiguration,
  options: SlackActivationOptions,
): Promise<SlackArchiveConfiguration> => {
  const config = validateSlackArchiveConfiguration(original);
  if (!config.account_id || !config.worker_name || !config.worker_url) {
    throw new Error("Deploy the archive Worker before activating Slack events");
  }
  if (!/^T[A-Z0-9]{8,}$/u.test(options.teamId) || !/^A[A-Z0-9]{8,}$/u.test(options.appId)) {
    throw new Error("Enter the Slack workspace team ID and app ID from your new Slack app");
  }
  const runner = options.runner ?? runProcess;
  const secrets = await runner("wrangler", ["secret", "list", "--name", config.worker_name, "--format", "json"], {
    env: { CLOUDFLARE_ACCOUNT_ID: config.account_id },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(secrets.stdout);
  } catch {
    throw new Error("Cloudflare did not return a readable Worker secret list");
  }
  if (!Array.isArray(parsed)) throw new Error("Cloudflare did not return a readable Worker secret list");
  const names = new Set(parsed.flatMap(item =>
    typeof item === "object" && item !== null && "name" in item && typeof item.name === "string"
      ? [item.name] : []));
  const missing = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].filter(name => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Add ${missing.join(" and ")} to the archive Worker secrets in Cloudflare, then retry activation. Secret values are never saved by ArtifactPass.`);
  }

  const prepared: SlackArchiveConfiguration = {
    ...config,
    team_id: options.teamId,
    app_id: options.appId,
    stage: "manifest-pending",
    updated_at: new Date().toISOString(),
  };
  await writeSlackArchiveConfiguration(options.statePath, prepared);
  const deployed = await provisionSlackResources(prepared, {
    accountId: config.account_id,
    statePath: options.statePath,
    deploymentRoot: options.deploymentRoot,
    runner,
    approved: true,
  });
  const manifestPath = join(dirname(options.statePath), "app-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(createSlackAppManifest(deployed, deployed.worker_url ?? ""), null, 2)}\n`, { mode: 0o600 });
  return deployed;
};
