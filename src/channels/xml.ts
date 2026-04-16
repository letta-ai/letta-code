/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getLocalTime } from "../cli/helpers/sessionContext";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import type {
  ChannelMessageAttachment,
  ChannelThreadContextEntry,
  InboundChannelMessage,
} from "./types";

/**
 * Escape XML text-node content without over-escaping quotes that should remain
 * readable inside the rendered message body.
 */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape XML attribute values, including quotes.
 */
function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Format the reminder text that explains channel reply semantics to the agent.
 */
export function buildChannelReminderText(msg: InboundChannelMessage): string {
  const localTime = escapeXmlText(getLocalTime());
  const escapedChannel = escapeXmlText(msg.channel);
  const escapedChatId = escapeXmlText(msg.chatId);
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
  if (msg.channel === "telegram") {
    lines.splice(
      lines.length - 2,
      0,
      'On Telegram, MessageChannel also supports action="react" with emoji + messageId, and action="upload-file" with media.',
    );
  }
  if (msg.channel === "discord") {
    lines.splice(
      lines.length - 2,
      0,
      'On Discord, MessageChannel also supports action="react" with emoji + messageId, and action="upload-file" with media. Discord uses native Unicode emoji for reactions.',
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
    `kind="${escapeXmlAttribute(attachment.kind)}"`,
    `local_path="${escapeXmlAttribute(attachment.localPath)}"`,
  ];

  if (attachment.id) {
    attrs.push(`attachment_id="${escapeXmlAttribute(attachment.id)}"`);
  }
  if (attachment.name) {
    attrs.push(`name="${escapeXmlAttribute(attachment.name)}"`);
  }
  if (attachment.mimeType) {
    attrs.push(`mime_type="${escapeXmlAttribute(attachment.mimeType)}"`);
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
    `action="${escapeXmlAttribute(msg.reaction.action)}"`,
    `emoji="${escapeXmlAttribute(msg.reaction.emoji)}"`,
    `target_message_id="${escapeXmlAttribute(msg.reaction.targetMessageId)}"`,
  ];

  if (msg.reaction.targetSenderId) {
    attrs.push(
      `target_sender_id="${escapeXmlAttribute(msg.reaction.targetSenderId)}"`,
    );
  }

  return `<reaction ${attrs.join(" ")} />`;
}

function buildThreadContextEntryXml(
  tagName: string,
  entry: ChannelThreadContextEntry,
): string {
  const attrs: string[] = [];
  if (entry.senderId) {
    attrs.push(`sender_id="${escapeXmlAttribute(entry.senderId)}"`);
  }
  if (entry.senderName) {
    attrs.push(`sender_name="${escapeXmlAttribute(entry.senderName)}"`);
  }
  if (entry.messageId) {
    attrs.push(`message_id="${escapeXmlAttribute(entry.messageId)}"`);
  }

  const attrString = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `<${tagName}${attrString}>\n${escapeXmlText(entry.text)}\n</${tagName}>`;
}

function buildThreadContextXml(msg: InboundChannelMessage): string | null {
  const threadContext = msg.threadContext;
  if (!threadContext) {
    return null;
  }

  const parts: string[] = [];
  if (threadContext.starter) {
    parts.push(
      buildThreadContextEntryXml("thread-starter", threadContext.starter),
    );
  }
  const historyEntries = threadContext.history ?? [];
  if (historyEntries.length > 0) {
    parts.push(
      [
        "<thread-history>",
        ...historyEntries.map((entry) =>
          buildThreadContextEntryXml("thread-message", entry),
        ),
        "</thread-history>",
      ].join("\n"),
    );
  }

  if (parts.length === 0) {
    return null;
  }

  const attrs = threadContext.label
    ? ` label="${escapeXmlAttribute(threadContext.label)}"`
    : "";
  return [`<thread-context${attrs}>`, ...parts, "</thread-context>"].join("\n");
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
    `source="${escapeXmlAttribute(msg.channel)}"`,
    `chat_id="${escapeXmlAttribute(msg.chatId)}"`,
    `sender_id="${escapeXmlAttribute(msg.senderId)}"`,
  ];

  if (msg.senderName) {
    attrs.push(`sender_name="${escapeXmlAttribute(msg.senderName)}"`);
  }

  if (msg.messageId) {
    attrs.push(`message_id="${escapeXmlAttribute(msg.messageId)}"`);
  }

  if (msg.threadId) {
    attrs.push(`thread_id="${escapeXmlAttribute(msg.threadId)}"`);
  }

  const attrString = attrs.join(" ");
  const escapedText = msg.text ? escapeXmlText(msg.text) : "";
  const reactionXml = buildReactionXml(msg);
  const threadContextXml = buildThreadContextXml(msg);
  const attachmentXml = (msg.attachments ?? []).map(buildAttachmentXml);
  const body = [threadContextXml, reactionXml, ...attachmentXml, escapedText]
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
