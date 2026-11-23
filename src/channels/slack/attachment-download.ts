import type { ChannelMessageAttachment } from "@/channels/types";
import {
  resolveSlackMessageFiles,
  type SlackAttachmentReadClient,
} from "./attachment-primitives";
import { materializeSlackAttachment } from "./media";

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
