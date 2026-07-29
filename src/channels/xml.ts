/**
 * XML formatting for channel notifications.
 *
 * Produces structured XML that the agent receives as message content.
 * Follows the same escaping patterns used in taskNotifications.ts.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getLocalTime } from "@/cli/helpers/session-context";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
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

function formatMebibytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  const rounded =
    mebibytes >= 100 ? Math.round(mebibytes).toString() : mebibytes.toFixed(1);
  return `${rounded.replace(/\.0$/, "")} MiB`;
}

function hasNotificationAttachmentPaths(msg: InboundChannelMessage): boolean {
  if (msg.attachments?.some((attachment) => attachment.localPath)) {
    return true;
  }
  if (
    msg.threadContext?.starter?.attachments?.some(
      (attachment) => attachment.localPath,
    )
  ) {
    return true;
  }
  return Boolean(
    msg.threadContext?.history?.some((entry) =>
      entry.attachments?.some((attachment) => attachment.localPath),
    ),
  );
}

/**
 * Format the reminder text that explains channel reply semantics to the agent.
 */
export function buildChannelReminderText(msg: InboundChannelMessage): string {
  const localTime = escapeXmlText(getLocalTime());
  const escapedChannel = escapeXmlText(msg.channel);

  const lines = [
    SYSTEM_REMINDER_OPEN,
    `External ${escapedChannel} turn. Plain assistant text is not delivered; follow the scoped MessageChannel instructions to respond.`,
    `Current local time on this device: ${localTime}`,
    SYSTEM_REMINDER_CLOSE,
  ];

  if (hasNotificationAttachmentPaths(msg)) {
    lines.splice(
      lines.length - 2,
      0,
      "If this notification includes attachment local_path values, you may be able to inspect those files using local file or image tools available in your current toolset (for example Read or ViewImage), using the local_path.",
    );
  }

  return lines.join("\n");
}

type AttachmentXmlContext = {
  channel: string;
  accountId?: string;
  chatId: string;
  messageId?: string;
};

function buildAttachmentXml(
  attachment: ChannelMessageAttachment,
  context: AttachmentXmlContext,
): string {
  const attrs = [`kind="${escapeXmlAttribute(attachment.kind)}"`];

  if (attachment.localPath) {
    attrs.push(`local_path="${escapeXmlAttribute(attachment.localPath)}"`);
  } else {
    attrs.push('download_status="not_downloaded"');
  }

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
  const sourceMessageId = attachment.sourceMessageId ?? context.messageId;
  if (!attachment.localPath && sourceMessageId) {
    attrs.push(`source_message_id="${escapeXmlAttribute(sourceMessageId)}"`);
  }
  if (!attachment.localPath && attachment.sourceThreadId) {
    attrs.push(
      `source_thread_id="${escapeXmlAttribute(attachment.sourceThreadId)}"`,
    );
  }
  if (attachment.downloadReason) {
    attrs.push(
      `download_reason="${escapeXmlAttribute(attachment.downloadReason)}"`,
    );
  }
  if (typeof attachment.autoDownloadLimitBytes === "number") {
    attrs.push(
      `auto_download_limit_bytes="${attachment.autoDownloadLimitBytes}"`,
    );
  }

  const children: string[] = [];
  if (attachment.transcription) {
    children.push(
      `<attempted_transcription>${escapeXmlText(attachment.transcription)}</attempted_transcription>`,
    );
  }
  if (attachment.transcriptionError) {
    children.push(
      `<attempted_transcription_error>${escapeXmlText(attachment.transcriptionError)}</attempted_transcription_error>`,
    );
  }
  if (
    !attachment.localPath &&
    context.channel === "slack" &&
    attachment.id &&
    sourceMessageId
  ) {
    const accountArg = context.accountId
      ? `, accountId="${escapeXmlAttribute(context.accountId)}"`
      : "";
    const threadArg = attachment.sourceThreadId
      ? `, threadId="${escapeXmlAttribute(attachment.sourceThreadId)}"`
      : "";
    const action = `MessageChannel with action="download-file", channel="slack", chat_id="${escapeXmlAttribute(context.chatId)}"${accountArg}${threadArg}, attachmentId="${escapeXmlAttribute(attachment.id)}", and messageId="${escapeXmlAttribute(sourceMessageId)}"`;
    if (attachment.downloadReason === "exceeds_auto_download_limit") {
      const sizeNote =
        typeof attachment.sizeBytes === "number"
          ? `This file is ${formatMebibytes(attachment.sizeBytes)}${
              typeof attachment.autoDownloadLimitBytes === "number"
                ? `, above the ${formatMebibytes(attachment.autoDownloadLimitBytes)} automatic download limit`
                : ""
            }. `
          : "";
      children.push(
        `<download-instruction>${sizeNote}Call ${action}. The tool downloads the file into the same Slack inbound attachment directory and returns its local_path. Large downloads return a task_id instead of blocking; wait for the local_path with TaskOutput (block: true, timeout: 600000). Do not ask the sender to reattach it.</download-instruction>`,
      );
    } else {
      children.push(
        `<download-retry>Automatic download did not complete. Call ${action} to retry. The action may return a precise error if Slack still cannot provide the file.</download-retry>`,
      );
    }
  }

  if (children.length > 0) {
    return `<attachment ${attrs.join(" ")}>\n  ${children.join("\n  ")}\n</attachment>`;
  }

  return `<attachment ${attrs.join(" ")} />`;
}

function canEmitInlineImageContentPart(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return (
    !!normalized &&
    normalized.startsWith("image/") &&
    normalized !== "image/svg+xml"
  );
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

function buildReplyContextXml(msg: InboundChannelMessage): string | null {
  const replyContext = msg.replyContext;
  if (!replyContext) {
    return null;
  }

  const attrs: string[] = [];
  if (replyContext.messageId) {
    attrs.push(`message_id="${escapeXmlAttribute(replyContext.messageId)}"`);
  }
  if (replyContext.senderId) {
    attrs.push(`sender_id="${escapeXmlAttribute(replyContext.senderId)}"`);
  }
  if (replyContext.senderName) {
    attrs.push(`sender_name="${escapeXmlAttribute(replyContext.senderName)}"`);
  }

  const attrString = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  if (replyContext.text?.trim()) {
    return `<reply-context${attrString}>\n${escapeXmlText(replyContext.text)}\n</reply-context>`;
  }
  return `<reply-context${attrString} />`;
}

function buildThreadContextEntryXml(
  tagName: string,
  entry: ChannelThreadContextEntry,
  context: Omit<AttachmentXmlContext, "messageId">,
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
  const body = [
    ...(entry.text ? [escapeXmlText(entry.text)] : []),
    ...(entry.attachments ?? []).map((attachment) =>
      buildAttachmentXml(attachment, {
        ...context,
        messageId: entry.messageId,
      }),
    ),
  ].join("\n");
  return `<${tagName}${attrString}>\n${body}\n</${tagName}>`;
}

function buildThreadContextXml(msg: InboundChannelMessage): string | null {
  const threadContext = msg.threadContext;
  if (!threadContext) {
    return null;
  }

  const parts: string[] = [];
  if (threadContext.starter) {
    parts.push(
      buildThreadContextEntryXml("thread-starter", threadContext.starter, {
        channel: msg.channel,
        accountId: msg.accountId,
        chatId: msg.chatId,
      }),
    );
  }
  const historyEntries = threadContext.history ?? [];
  if (historyEntries.length > 0) {
    parts.push(
      [
        "<thread-history>",
        ...historyEntries.map((entry) =>
          buildThreadContextEntryXml("thread-message", entry, {
            channel: msg.channel,
            accountId: msg.accountId,
            chatId: msg.chatId,
          }),
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

  if (msg.accountId) {
    attrs.push(`account_id="${escapeXmlAttribute(msg.accountId)}"`);
  }

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
  const replyContextXml = buildReplyContextXml(msg);
  const threadContextXml = buildThreadContextXml(msg);
  const attachmentXml = (msg.attachments ?? []).map((attachment) =>
    buildAttachmentXml(attachment, {
      channel: msg.channel,
      accountId: msg.accountId,
      chatId: msg.chatId,
      messageId: msg.messageId,
    }),
  );
  const body = [
    threadContextXml,
    replyContextXml,
    reactionXml,
    ...attachmentXml,
    escapedText,
  ]
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
        !canEmitInlineImageContentPart(attachment.mimeType)
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
