/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getLocalTime } from "../cli/helpers/sessionContext";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import type { ChannelMessageAttachment, InboundChannelMessage } from "./types";

/**
 * Escape special XML characters in text content.
 * Reference: src/cli/helpers/taskNotifications.ts uses similar escaping.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format the reminder text that explains channel reply semantics to the agent.
 */
export function buildChannelReminderText(msg: InboundChannelMessage): string {
  const localTime = escapeXml(getLocalTime());
  const escapedChannel = escapeXml(msg.channel);
  const escapedChatId = escapeXml(msg.chatId);
  const threadLine =
    msg.channel === "slack" &&
    msg.chatType === "channel" &&
    (msg.threadId ?? msg.messageId)?.trim()
      ? "Replies sent with MessageChannel will stay in the same Slack thread automatically."
      : null;

  const lines = [
    SYSTEM_REMINDER_OPEN,
    `This message originated from an external ${escapedChannel} channel.`,
    `If you want to ensure the user on ${escapedChannel} will see your reply, you must call the MessageChannel tool to send a message back on the same channel.`,
    `Use action="send", channel="${escapedChannel}", and chat_id="${escapedChatId}" when calling MessageChannel, and put your reply text in message.`,
    "Only pass replyTo if you intentionally want the platform's quote/reply UI.",
    `Current local time on this device: ${localTime}`,
    SYSTEM_REMINDER_CLOSE,
  ];

  if (threadLine) {
    lines.splice(lines.length - 2, 0, threadLine);
  }
  if (msg.channel === "slack") {
    lines.splice(
      lines.length - 2,
      0,
      'On Slack, MessageChannel also supports action="react" with emoji + messageId, and action="upload-file" with media.',
    );
  }
  if (msg.attachments?.length) {
    lines.splice(
      lines.length - 2,
      0,
      "If this notification includes attachment local_path values, you can inspect those files with the Read tool.",
    );
  }

  return lines.join("\n");
}

function buildAttachmentXml(attachment: ChannelMessageAttachment): string {
  const attrs = [
    `kind="${escapeXml(attachment.kind)}"`,
    `local_path="${escapeXml(attachment.localPath)}"`,
  ];

  if (attachment.id) {
    attrs.push(`attachment_id="${escapeXml(attachment.id)}"`);
  }
  if (attachment.name) {
    attrs.push(`name="${escapeXml(attachment.name)}"`);
  }
  if (attachment.mimeType) {
    attrs.push(`mime_type="${escapeXml(attachment.mimeType)}"`);
  }
  if (typeof attachment.sizeBytes === "number") {
    attrs.push(`size_bytes="${attachment.sizeBytes}"`);
  }

  return `<attachment ${attrs.join(" ")} />`;
}

function buildReactionXml(msg: InboundChannelMessage): string | null {
  if (!msg.reaction) {
    return null;
  }

  const attrs = [
    `action="${escapeXml(msg.reaction.action)}"`,
    `emoji="${escapeXml(msg.reaction.emoji)}"`,
    `target_message_id="${escapeXml(msg.reaction.targetMessageId)}"`,
  ];

  if (msg.reaction.targetSenderId) {
    attrs.push(`target_sender_id="${escapeXml(msg.reaction.targetSenderId)}"`);
  }

  return `<reaction ${attrs.join(" ")} />`;
}

/**
 * Format an inbound channel message as XML for the agent.
 *
 * Example output:
 * ```xml
 * <channel-notification source="telegram" chat_id="12345" sender_id="67890" sender_name="John">
 * Hello from Telegram!
 * </channel-notification>
 * ```
 */
export function buildChannelNotificationXml(
  msg: InboundChannelMessage,
): string {
  const attrs: string[] = [
    `source="${escapeXml(msg.channel)}"`,
    `chat_id="${escapeXml(msg.chatId)}"`,
    `sender_id="${escapeXml(msg.senderId)}"`,
  ];

  if (msg.senderName) {
    attrs.push(`sender_name="${escapeXml(msg.senderName)}"`);
  }

  if (msg.messageId) {
    attrs.push(`message_id="${escapeXml(msg.messageId)}"`);
  }

  if (msg.threadId) {
    attrs.push(`thread_id="${escapeXml(msg.threadId)}"`);
  }

  const attrString = attrs.join(" ");
  const escapedText = msg.text ? escapeXml(msg.text) : "";
  const reactionXml = buildReactionXml(msg);
  const attachmentXml = (msg.attachments ?? []).map(buildAttachmentXml);
  const body = [reactionXml, ...attachmentXml, escapedText]
    .filter(Boolean)
    .join("\n");

  return `<channel-notification ${attrString}>\n${body}\n</channel-notification>`;
}

/**
 * Format an inbound channel message as structured content parts.
 *
 * The reminder and the notification XML are emitted as separate text parts so
 * UIs that already know how to hide pure system-reminder parts can do so
 * without needing to parse concatenated XML blobs.
 */
export function formatChannelNotification(
  msg: InboundChannelMessage,
): MessageCreate["content"] {
  return [
    { type: "text", text: buildChannelReminderText(msg) },
    { type: "text", text: buildChannelNotificationXml(msg) },
    ...(msg.attachments ?? []).flatMap((attachment) => {
      if (
        attachment.kind !== "image" ||
        typeof attachment.imageDataBase64 !== "string" ||
        attachment.imageDataBase64.length === 0 ||
        typeof attachment.mimeType !== "string" ||
        !attachment.mimeType.startsWith("image/")
      ) {
        return [];
      }

      return [
        {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: attachment.mimeType,
            data: attachment.imageDataBase64,
          },
        },
      ];
    }),
  ] as MessageCreate["content"];
}
