import { beginCompletion, claimDelivery, finishDelivery, scheduleRetry, type DeliveryDatabase } from "./delivery-store";
import type { QueuedArchiveJob } from "./event-receiver";
import { parseApprovedShareUrl } from "./source-policy";
import { archiveSource, ArchiveTransferError, type ArchiveTransferOptions } from "./slack-upload";

export interface ArchiveQueueMessage {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export interface ArchiveQueueBatch {
  readonly messages: readonly ArchiveQueueMessage[];
}

export interface ArchiveConsumerOptions {
  readonly database: DeliveryDatabase;
  readonly botToken: string;
  readonly approvedOrigins: readonly string[];
  readonly now: () => number;
  readonly transfer?: (job: QueuedArchiveJob, options: ArchiveTransferOptions) => Promise<{ readonly fileId: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const queuedJob = (value: unknown, origins: readonly string[]): QueuedArchiveJob | null => {
  if (!isRecord(value) ||
      typeof value.id !== "string" || !/^[a-f0-9]{64}$/u.test(value.id) ||
      typeof value.channelId !== "string" || !/^[CG][A-Z0-9]{8,}$/u.test(value.channelId) ||
      typeof value.messageTs !== "string" || !/^\d{9,}\.\d{1,6}$/u.test(value.messageTs) ||
      typeof value.threadTs !== "string" || !/^\d{9,}\.\d{1,6}$/u.test(value.threadTs) ||
      !parseApprovedShareUrl(value.shareUrl, origins)) return null;
  return value as unknown as QueuedArchiveJob;
};

const retryDelaySeconds = 30;
const maximumAttempts = 3;

export const consumeArchiveBatch = async (batch: ArchiveQueueBatch, options: ArchiveConsumerOptions): Promise<void> => {
  for (const message of batch.messages) {
    const job = queuedJob(message.body, options.approvedOrigins);
    if (!job) {
      message.ack();
      continue;
    }
    let claimId: string | null;
    try {
      claimId = await claimDelivery(options.database, job, options.now());
    } catch {
      message.retry({ delaySeconds: retryDelaySeconds });
      continue;
    }
    if (!claimId) {
      message.ack();
      continue;
    }
    try {
      const result = await (options.transfer ?? archiveSource)(job, {
        approvedOrigins: options.approvedOrigins,
        botToken: options.botToken,
        now: options.now,
        onCompletionStart: async () => {
          const marked = await beginCompletion(options.database, job.id, claimId, options.now());
          if (!marked) throw new Error("Delivery claim is no longer active");
        },
      });
      await finishDelivery(options.database, job.id, claimId, "succeeded", options.now(), null, result.fileId);
      message.ack();
    } catch (error) {
      const failure = error instanceof ArchiveTransferError
        ? error : new ArchiveTransferError("retryable", "unexpected_transfer_error");
      try {
        if (failure.kind === "needs-review") {
          await finishDelivery(options.database, job.id, claimId, "needs-review", options.now(), failure.code);
          message.ack();
        } else if (failure.kind === "terminal" || message.attempts >= maximumAttempts) {
          await finishDelivery(options.database, job.id, claimId, "failed", options.now(),
            message.attempts >= maximumAttempts && failure.kind !== "terminal" ? "retry_budget_exhausted" : failure.code);
          message.ack();
        } else if (await scheduleRetry(options.database, job.id, claimId, failure.code,
          options.now(), retryDelaySeconds * 1_000)) {
          message.retry({ delaySeconds: retryDelaySeconds });
        } else {
          message.ack();
        }
      } catch {
        message.retry({ delaySeconds: retryDelaySeconds });
      }
    }
  }
};
