/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getLocalTime } from "../cli/helpers/sessionContext";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import type { InboundChannelMessage } from "./types";

/**
 * Escape special XML characters in text nodes.
 * Quotes do not need escaping in text content, and preserving them avoids
 * leaking XML entity sequences like &apos; back into downstream channel replies.
 */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape special XML characters in attribute values.
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
    msg.messageId?.trim()
      ? `Use reply_to_message_id="${escapeXmlText(msg.messageId)}" if you want your reply to stay in the same Slack thread.`
      : null;

  const lines = [
    SYSTEM_REMINDER_OPEN,
    `This message originated from an external ${escapedChannel} channel.`,
    `If you want to ensure the user on ${escapedChannel} will see your reply, you must call the MessageChannel tool to send a message back on the same channel.`,
    `Use channel="${escapedChannel}" and chat_id="${escapedChatId}" when calling MessageChannel.`,
    "Only pass reply_to_message_id if you intentionally want the platform's quote/reply UI.",
    `Current local time on this device: ${localTime}`,
    SYSTEM_REMINDER_CLOSE,
  ];

  if (threadLine) {
    lines.splice(lines.length - 2, 0, threadLine);
  }

  return lines.join("\n");
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

  const attrString = attrs.join(" ");
  const escapedText = escapeXmlText(msg.text);

  return `<channel-notification ${attrString}>\n${escapedText}\n</channel-notification>`;
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
  ] as MessageCreate["content"];
}
