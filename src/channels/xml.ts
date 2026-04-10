/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

import { getLocalTime } from "../cli/helpers/sessionContext";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import type { InboundChannelMessage } from "./types";

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
 * Format an inbound channel message as XML for the agent.
 *
 * Example output:
 * ```xml
 * <channel-notification source="telegram" chat_id="12345" sender_id="67890" sender_name="John">
 * Hello from Telegram!
 * </channel-notification>
 * ```
 */
export function formatChannelNotification(msg: InboundChannelMessage): string {
  const localTime = escapeXml(getLocalTime());
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

  const attrString = attrs.join(" ");
  const escapedText = escapeXml(msg.text);
  const escapedChannel = escapeXml(msg.channel);
  const escapedChatId = escapeXml(msg.chatId);

  const reminder = [
    SYSTEM_REMINDER_OPEN,
    `This message originated from an external ${escapedChannel} channel.`,
    `If you want the ensure the user on ${escapedChannel} will see your reply, you must call the MessageChannel tool to send a message back on the same channel.`,
    `Use channel="${escapedChannel}" and chat_id="${escapedChatId}" when calling MessageChannel.`,
    "Only pass reply_to_message_id if you intentionally want the platform's quote/reply UI.",
    `Current local time on this device: ${localTime}`,
    SYSTEM_REMINDER_CLOSE,
  ].join("\n");

  return `${reminder}\n<channel-notification ${attrString}>\n${escapedText}\n</channel-notification>`;
}
