import type { ChannelMessageAttachment } from "@/channels/types";
import {
  resolveSlackMessageFiles,
  type SlackAttachmentReadClient,
} from "./attachment-primitives";
import { materializeSlackAttachment } from "./media";

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
  signal?: AbortSignal;
}): Promise<ChannelMessageAttachment> {
  const files = await resolveSlackMessageFiles(params);
  if (!files) {
    throw new Error(
      `Slack message ${params.messageTs} was not found in chat ${params.channelId}.`,
    );
  }

  const file = files.find((entry) => entry.id === params.attachmentId);
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
    signal: params.signal,
  });
}
