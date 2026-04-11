/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { resizeImageIfNeeded } from "../cli/helpers/imageResize";
import { getLocalTime } from "../cli/helpers/sessionContext";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import type { InboundChannelAttachment, InboundChannelMessage } from "./types";

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

  return [
    SYSTEM_REMINDER_OPEN,
    `This message originated from an external ${escapedChannel} channel.`,
    `If you want the ensure the user on ${escapedChannel} will see your reply, you must call the MessageChannel tool to send a message back on the same channel.`,
    `Use channel="${escapedChannel}" and chat_id="${escapedChatId}" when calling MessageChannel.`,
    "Only pass reply_to_message_id if you intentionally want the platform's quote/reply UI.",
    `Current local time on this device: ${localTime}`,
    SYSTEM_REMINDER_CLOSE,
  ].join("\n");
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

  const attrString = attrs.join(" ");
  if (!msg.attachments || msg.attachments.length === 0) {
    const escapedText = escapeXml(msg.text);
    return `<channel-notification ${attrString}>\n${escapedText}\n</channel-notification>`;
  }

  const lines = [`<channel-notification ${attrString}>`];

  if (msg.text.length > 0) {
    lines.push(`  <text>${escapeXml(msg.text)}</text>`);
  }

  lines.push("  <attachments>");
  for (const attachment of msg.attachments) {
    lines.push(`    ${buildAttachmentXml(attachment)}`);
  }
  lines.push("  </attachments>");
  lines.push("</channel-notification>");

  return lines.join("\n");
}

/**
 * Format an inbound channel message as structured content parts.
 *
 * The reminder and the notification XML are emitted as separate text parts so
 * UIs that already know how to hide pure system-reminder parts can do so
 * without needing to parse concatenated XML blobs.
 */
export async function formatChannelNotification(
  msg: InboundChannelMessage,
): Promise<MessageCreate["content"]> {
  const imageParts = await buildInlineImageParts(msg.attachments);

  return [
    { type: "text", text: buildChannelReminderText(msg) },
    { type: "text", text: buildChannelNotificationXml(msg) },
    ...imageParts,
  ] as MessageCreate["content"];
}

const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const INLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

function buildAttachmentXml(attachment: InboundChannelAttachment): string {
  const attrs = [`kind="${escapeXml(attachment.kind)}"`];

  if (attachment.name) {
    attrs.push(`name="${escapeXml(attachment.name)}"`);
  }
  if (attachment.mimeType) {
    attrs.push(`mime_type="${escapeXml(attachment.mimeType)}"`);
  }
  if (typeof attachment.sizeBytes === "number") {
    attrs.push(`size_bytes="${attachment.sizeBytes}"`);
  }
  if (attachment.localPath) {
    attrs.push(`local_path="${escapeXml(attachment.localPath)}"`);
  }

  return `<attachment ${attrs.join(" ")} />`;
}

function normalizeImageMimeType(mimeType?: string): string | null {
  if (!mimeType) {
    return null;
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalized && INLINE_IMAGE_MIME_TYPES.has(normalized)
    ? normalized
    : null;
}

function inferImageMimeTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!INLINE_IMAGE_EXTENSIONS.has(ext)) {
    return null;
  }

  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".webp") {
    return "image/webp";
  }

  return "image/jpeg";
}

function canInlineImageAttachment(
  attachment: InboundChannelAttachment,
): attachment is InboundChannelAttachment & { localPath: string } {
  if (attachment.kind !== "image" || !attachment.localPath) {
    return false;
  }

  return Boolean(
    normalizeImageMimeType(attachment.mimeType) ??
      inferImageMimeTypeFromPath(attachment.localPath),
  );
}

async function buildInlineImagePart(
  attachment: InboundChannelAttachment & { localPath: string },
): Promise<Exclude<MessageCreate["content"], string>[number] | null> {
  const mediaType =
    normalizeImageMimeType(attachment.mimeType) ??
    inferImageMimeTypeFromPath(attachment.localPath);
  if (!mediaType) {
    return null;
  }

  try {
    const buffer = await fs.readFile(attachment.localPath);
    const resized = await resizeImageIfNeeded(buffer, mediaType);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: resized.mediaType,
        data: resized.data,
      },
    };
  } catch {
    return null;
  }
}

async function buildInlineImageParts(
  attachments: InboundChannelAttachment[] | undefined,
): Promise<Array<Exclude<MessageCreate["content"], string>[number]>> {
  const inlineCandidates = (attachments ?? []).filter(canInlineImageAttachment);
  if (inlineCandidates.length === 0) {
    return [];
  }

  const parts = await Promise.all(
    inlineCandidates.map((attachment) => buildInlineImagePart(attachment)),
  );
  return parts.filter(
    (part): part is Exclude<MessageCreate["content"], string>[number] =>
      part !== null,
  );
}
