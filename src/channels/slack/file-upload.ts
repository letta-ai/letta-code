import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { OutboundChannelMessage } from "@/channels/types";
import type { SlackWriteClient } from "./internal-types";
import { resolveSlackOutboundThreadTs } from "./utils";

function resolveUploadMimeType(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    default:
      return undefined;
  }
}

export async function uploadSlackFile(
  slackClient: SlackWriteClient,
  msg: OutboundChannelMessage,
): Promise<{ messageId: string }> {
  if (!msg.mediaPath) {
    throw new Error("mediaPath is required for Slack file uploads.");
  }

  const buffer = await readFile(msg.mediaPath);
  const uploadFileName = msg.fileName ?? basename(msg.mediaPath);
  const uploadTitle = msg.title ?? uploadFileName;
  const uploadMimeType = resolveUploadMimeType(uploadFileName);
  const uploadUrlResp = await slackClient.files.getUploadURLExternal({
    filename: uploadFileName,
    length: buffer.length,
  });
  if (
    !uploadUrlResp.ok ||
    !uploadUrlResp.upload_url ||
    !uploadUrlResp.file_id
  ) {
    throw new Error(
      `Failed to get Slack upload URL: ${uploadUrlResp.error ?? "unknown error"}`,
    );
  }

  const uploadResp = await fetch(uploadUrlResp.upload_url, {
    method: "POST",
    ...(uploadMimeType ? { headers: { "Content-Type": uploadMimeType } } : {}),
    body: buffer,
  });
  if (!uploadResp.ok) {
    throw new Error(`Failed to upload Slack file: HTTP ${uploadResp.status}`);
  }

  const threadTs = resolveSlackOutboundThreadTs({
    chatId: msg.chatId,
    threadId: msg.threadId,
    replyToMessageId: msg.replyToMessageId,
  });
  const completeResp = await slackClient.files.completeUploadExternal({
    files: [{ id: uploadUrlResp.file_id, title: uploadTitle }],
    channel_id: msg.chatId,
    ...(msg.text.trim() ? { initial_comment: msg.text } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  if (!completeResp.ok) {
    throw new Error(
      `Failed to complete Slack upload: ${completeResp.error ?? "unknown error"}`,
    );
  }
  return { messageId: uploadUrlResp.file_id };
}
