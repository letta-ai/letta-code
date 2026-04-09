/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

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

  return `<channel-notification ${attrString}>\n${escapedText}\n</channel-notification>`;
}
