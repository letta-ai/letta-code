import type { ChannelMessageActionContext } from "@/channels/plugin-types";
import type { SlackChannelAccount } from "@/channels/types";
import { runSlackAttachmentDownloadTask } from "./attachment-task";
import { createSlackMessageActionAdapter } from "./message-action-contract";
import { resolveSlackMessageTarget } from "./target-resolution";

async function downloadSlackFile(
  context: ChannelMessageActionContext,
): Promise<string> {
  const { request } = context;
  const attachmentId = request.attachmentId?.trim();
  if (!attachmentId) {
    return "Error: Slack download-file requires attachmentId.";
  }
  const messageId = request.messageId?.trim();
  if (!messageId) {
    return "Error: Slack download-file requires messageId from the attachment's Slack context.";
  }
  const downloadAttachment = context.adapter.downloadAttachment;
  if (typeof downloadAttachment !== "function") {
    return "Error: Running Slack adapter does not support attachment downloads.";
  }

  const result = await runSlackAttachmentDownloadTask({
    description: `Slack attachment download ${attachmentId} from message ${messageId} in ${request.chatId}`,
    runtimeScope: {
      agentId: context.route.agentId,
      conversationId: context.route.conversationId,
    },
    download: (signal) =>
      downloadAttachment.call(context.adapter, {
        attachmentId,
        chatId: request.chatId,
        threadId: request.threadId ?? null,
        messageId,
        signal,
      }),
  });

  if (result.outcome === "failed") {
    return `Error: Slack attachment download failed: ${result.error}`;
  }
  if (result.outcome === "backgrounded") {
    return [
      `Slack attachment download is still running in the background (task_id: ${result.taskId}).`,
      `Check on it with TaskOutput (task_id: ${result.taskId}, block: true, timeout: 600000) to wait for the local_path, or TaskStop to cancel.`,
      "You will not be notified automatically when it finishes.",
    ].join(" ");
  }
  if (!result.attachment.localPath) {
    return `Error: Slack attachment ${attachmentId} was not downloaded.`;
  }
  return `Slack attachment downloaded (local_path: ${result.attachment.localPath})`;
}

export const slackMessageActions = createSlackMessageActionAdapter({
  react: true,
  uploadFile: true,
  downloadFile: downloadSlackFile,
  resolveMessageTarget: async (params) =>
    await resolveSlackMessageTarget({
      account: params.account as SlackChannelAccount,
      target: params.target,
    }),
});
