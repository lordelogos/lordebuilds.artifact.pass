export interface ArchiveJob {
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs: string;
  readonly shareUrl: string;
}

export interface ArchiveSelectionConfig {
  readonly approvedOrigins: readonly string[];
  readonly enabledChannelIds: readonly string[];
}

const channelId = /^[CG][A-Z0-9]{8,}$/u;
const messageTimestamp = /^\d{9,}\.\d{1,6}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const selectArchiveJobs = (event: unknown, config: ArchiveSelectionConfig): ArchiveJob[] => {
  if (!isRecord(event) || event.type !== "link_shared") return [];
  if (event.source !== undefined && event.source !== "conversations_history") return [];
  if (event.is_bot_user_member !== true) return [];
  if (typeof event.channel !== "string" || !channelId.test(event.channel)) return [];
  if (!config.enabledChannelIds.includes(event.channel)) return [];
  if (typeof event.message_ts !== "string" || !messageTimestamp.test(event.message_ts)) return [];
  if (event.thread_ts !== undefined &&
      (typeof event.thread_ts !== "string" || !messageTimestamp.test(event.thread_ts))) return [];
  if (!Array.isArray(event.links)) return [];

  const jobs: ArchiveJob[] = [];
  const seen = new Set<string>();
  for (const link of event.links) {
    if (!isRecord(link)) continue;
    const share = parseApprovedShareUrl(link.url, config.approvedOrigins);
    if (!share || seen.has(share.shareUrl)) continue;
    seen.add(share.shareUrl);
    jobs.push({
      channelId: event.channel,
      messageTs: event.message_ts,
      threadTs: event.thread_ts ?? event.message_ts,
      shareUrl: share.shareUrl,
    });
  }
  return jobs;
};
import { parseApprovedShareUrl } from "./source-policy";

