import type { SlackArchiveConfiguration } from "./configuration";

const basicManifest = (config: SlackArchiveConfiguration) => ({
  display_information: {
    name: "ArtifactPass Archive",
    description: "Copy approved ArtifactPass links into their Slack threads",
    background_color: "#111827",
  },
  features: {
    bot_user: { display_name: "ArtifactPass Archive", always_online: false },
    unfurl_domains: config.sources.map(origin => new URL(origin).hostname),
  },
  oauth_config: { scopes: { bot: ["links:read", "files:write"] } },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
  },
});

export const createSlackBootstrapManifest = (config: SlackArchiveConfiguration) => basicManifest(config);

export const createSlackAppManifest = (config: SlackArchiveConfiguration, rawWorkerUrl: string) => {
  let worker: URL;
  try {
    worker = new URL(rawWorkerUrl);
  } catch {
    throw new Error("The archive Worker needs a public HTTPS URL before generating a Slack manifest");
  }
  if (worker.protocol !== "https:" || worker.origin !== rawWorkerUrl || worker.username || worker.password) {
    throw new Error("The archive Worker needs a public HTTPS origin before generating a Slack manifest");
  }
  return {
    ...basicManifest(config),
    settings: {
      ...basicManifest(config).settings,
      event_subscriptions: {
        request_url: `${worker.origin}/slack/events`,
        bot_events: ["link_shared"],
      },
    },
  } as const;
};
