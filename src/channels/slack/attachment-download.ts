import type { ChannelMessageAttachment } from "@/channels/types";
import type { SlackAttachmentReadClient } from "./attachment-types";
import { collectSlackFiles, materializeSlackAttachment } from "./media";

type SlackRepliesPageMessage = {
  ts?: string;
  files?: unknown[];
  attachments?: unknown[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function resolveCanonicalSlackMessage(params: {
  channelId: string;
  threadTs?: string | null;
  messageTs: string;
  client: SlackAttachmentReadClient;
}): Promise<SlackRepliesPageMessage | null> {
  if (isNonEmptyString(params.threadTs)) {
    let cursor: string | undefined;
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: 200,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;
      const message = (response.messages ?? []).find(
        (entry) => entry.ts === params.messageTs,
      );
      if (message) {
        return message;
      }
      const nextCursor = response.response_metadata?.next_cursor;
      cursor = isNonEmptyString(nextCursor) ? nextCursor.trim() : undefined;
    } while (cursor);
    return null;
  }

  const response = (await params.client.conversations.history({
    channel: params.channelId,
    oldest: params.messageTs,
    latest: params.messageTs,
    inclusive: true,
    limit: 1,
  })) as SlackRepliesPage;
  return (
    (response.messages ?? []).find((entry) => entry.ts === params.messageTs) ??
    null
  );
}

/**
 * Materialize one Slack attachment from its canonical source message.
 * Unlike automatic attachment ingestion, this explicit action has no hidden
 * size ceiling; it streams into the same inbound directory and returns the
 * local path. The canonical message lookup keeps file access scoped to the
 * routed Slack chat/thread instead of trusting a bare file id.
 */
export async function downloadSlackAttachmentById(params: {
  accountId: string;
  token: string;
  attachmentId: string;
  channelId: string;
  threadTs?: string | null;
  messageTs: string;
  client: SlackAttachmentReadClient;
}): Promise<ChannelMessageAttachment> {
  const message = await resolveCanonicalSlackMessage(params);
  if (!message) {
    throw new Error(
      `Slack message ${params.messageTs} was not found in chat ${params.channelId}.`,
    );
  }

  const file = collectSlackFiles(message).find(
    (entry) => entry.id === params.attachmentId,
  );
  if (!file) {
    throw new Error(
      `Slack attachment ${params.attachmentId} is not attached to message ${params.messageTs}.`,
    );
  }

  return await materializeSlackAttachment({
    accountId: params.accountId,
    token: params.token,
    file,
    sourceMessageId: params.messageTs,
    sourceThreadId: params.threadTs ?? null,
  });
}
