import { consumeArchiveBatch, type ArchiveQueueBatch } from "./archive-consumer";
import type { DeliveryDatabase } from "./delivery-store";
import { handleSlackEvent, type QueuedArchiveJob } from "./event-receiver";

export interface ArchiveEnvironment {
  readonly SLACK_SIGNING_SECRET: string;
  readonly SLACK_TEAM_ID: string;
  readonly SLACK_APP_ID: string;
  readonly APPROVED_ORIGINS: string;
  readonly ENABLED_CHANNEL_IDS: string;
  readonly ARCHIVE_QUEUE: { send(job: QueuedArchiveJob): Promise<void> };
  readonly ARCHIVE_DB: DeliveryDatabase;
  readonly SLACK_BOT_TOKEN: string;
}

const parseStringList = (value: string): string[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
    throw new Error("Invalid archive configuration");
  }
  return parsed;
};

export default {
  async fetch(request: Request, env: ArchiveEnvironment): Promise<Response> {
    if (new URL(request.url).pathname !== "/slack/events") {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await handleSlackEvent(request, {
        signingSecret: env.SLACK_SIGNING_SECRET,
        teamId: env.SLACK_TEAM_ID,
        appId: env.SLACK_APP_ID,
        approvedOrigins: parseStringList(env.APPROVED_ORIGINS),
        enabledChannelIds: parseStringList(env.ENABLED_CHANNEL_IDS),
        queue: env.ARCHIVE_QUEUE,
        now: Date.now,
      });
    } catch {
      return new Response("Archive intake unavailable", { status: 503 });
    }
  },
  async queue(batch: ArchiveQueueBatch, env: ArchiveEnvironment): Promise<void> {
    await consumeArchiveBatch(batch, {
      database: env.ARCHIVE_DB,
      botToken: env.SLACK_BOT_TOKEN,
      approvedOrigins: parseStringList(env.APPROVED_ORIGINS),
      now: Date.now,
    });
  },
};
