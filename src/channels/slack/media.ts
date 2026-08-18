import { readFile } from "node:fs/promises";
import type { ChannelMessageAttachment } from "@/channels/types";
import {
  collectSlackFiles,
  fetchSlackFile,
  resolveSlackFileMetadata,
  resolveSlackMessageFiles,
  type SlackAttachmentReadClient,
  type SlackFileLike,
} from "./attachment-primitives";
import {
  SlackAttachmentDownloadError,
  type SlackAttachmentDownloadFailureReason,
  saveSlackAttachmentStream,
} from "./attachment-stream";
import { hasSlackMention } from "./utils";

const MAX_SLACK_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type SlackAttachmentLike = {
  text?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  title?: string;
};

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown[];
  attachments?: unknown[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

type SlackThreadAttachmentParams = {
  accountId?: string;
  token?: string;
  transcribeVoice?: boolean;
};

type SlackThreadAttachmentOptions = {
  accountId: string;
  token: string;
  transcribeVoice?: boolean;
};

export type SlackThreadMessage = {
  text: string;
  userId?: string;
  botId?: string;
  ts?: string;
  attachments?: ChannelMessageAttachment[];
};

type SlackThreadHistoryEntryKind = "all" | "bot" | "unrouted-bot";

async function mapSlackThreadMessage(
  message: SlackRepliesPageMessage,
  attachmentOptions?: SlackThreadAttachmentOptions,
  sourceThreadId?: string,
): Promise<SlackThreadMessage> {
  const attachments = await resolveSlackMessageAttachments(
    message,
    attachmentOptions,
    sourceThreadId,
  );
  return {
    text: resolveSlackThreadMessageText(message),
    userId: isNonEmptyString(message.user) ? message.user : undefined,
    botId: isNonEmptyString(message.bot_id) ? message.bot_id : undefined,
    ts: isNonEmptyString(message.ts) ? message.ts : undefined,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSlackAttachmentLike(
  value: unknown,
): SlackAttachmentLike | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    text: isNonEmptyString(record.text) ? record.text : undefined,
    fallback: isNonEmptyString(record.fallback) ? record.fallback : undefined,
    pretext: isNonEmptyString(record.pretext) ? record.pretext : undefined,
    author_name: isNonEmptyString(record.author_name)
      ? record.author_name
      : undefined,
    title: isNonEmptyString(record.title) ? record.title : undefined,
  };
}

function uniqueNonEmptyStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function resolveSlackAttachmentText(attachment: SlackAttachmentLike): string {
  const parts = uniqueNonEmptyStrings([
    attachment.pretext,
    attachment.author_name,
    attachment.title,
    attachment.text,
    attachment.fallback,
  ]);

  return parts.join("\n");
}

function resolveSlackThreadMessageText(
  message: SlackRepliesPageMessage,
): string {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (text) {
    return text;
  }

  const attachmentTexts = Array.isArray(message.attachments)
    ? message.attachments
        .map((entry) => normalizeSlackAttachmentLike(entry))
        .filter((entry): entry is SlackAttachmentLike => Boolean(entry))
        .map((attachment) => resolveSlackAttachmentText(attachment))
        .filter(isNonEmptyString)
    : [];

  if (attachmentTexts.length > 0) {
    return attachmentTexts.join("\n\n");
  }

  const files = collectSlackFiles(message);

  if (files.length === 0) {
    return "";
  }

  const fileNames = files.map((file) => file.name ?? "file").join(", ");
  return `[attached: ${fileNames}]`;
}

function resolveAttachmentKind(
  mimeType?: string,
): ChannelMessageAttachment["kind"] {
  const normalized = mimeType?.toLowerCase();
  if (!normalized) {
    return "file";
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function createUndownloadedSlackAttachment(params: {
  file: SlackFileLike;
  sourceMessageId?: string;
  sourceThreadId?: string | null;
  reason: SlackAttachmentDownloadFailureReason;
}): ChannelMessageAttachment {
  const { fileName, mimeType } = resolveSlackFileMetadata({
    file: params.file,
  });
  return {
    id: params.file.id,
    name: fileName,
    mimeType,
    sizeBytes: params.file.size,
    kind: resolveAttachmentKind(mimeType),
    sourceMessageId: params.sourceMessageId,
    ...(params.sourceThreadId ? { sourceThreadId: params.sourceThreadId } : {}),
    downloadReason: params.reason,
    ...(params.reason === "exceeds_auto_download_limit"
      ? { autoDownloadLimitBytes: MAX_SLACK_ATTACHMENT_BYTES }
      : {}),
  };
}

export async function materializeSlackAttachment(params: {
  accountId: string;
  token: string;
  file: SlackFileLike;
  sourceMessageId?: string;
  sourceThreadId?: string | null;
  maxBytes?: number;
  transcribeVoice?: boolean;
  signal?: AbortSignal;
}): Promise<ChannelMessageAttachment> {
  if (
    params.maxBytes !== undefined &&
    typeof params.file.size === "number" &&
    params.file.size > params.maxBytes
  ) {
    throw new SlackAttachmentDownloadError(
      "exceeds_auto_download_limit",
      `Slack attachment is ${params.file.size} bytes; automatic download limit is ${params.maxBytes} bytes.`,
    );
  }

  const url = params.file.url_private_download ?? params.file.url_private;
  if (!url) {
    throw new SlackAttachmentDownloadError(
      "missing_download_url",
      "Slack attachment does not include a private download URL.",
    );
  }

  const fetched = await fetchSlackFile({
    token: params.token,
    file: params.file,
    signal: params.signal,
  }).catch((error) => {
    throw new SlackAttachmentDownloadError(
      "download_failed",
      error instanceof Error ? error.message : "Slack attachment fetch failed.",
    );
  });
  if (
    params.maxBytes !== undefined &&
    fetched.contentLength !== undefined &&
    fetched.contentLength > params.maxBytes
  ) {
    await fetched.body.cancel().catch(() => undefined);
    throw new SlackAttachmentDownloadError(
      "exceeds_auto_download_limit",
      `Slack attachment is ${fetched.contentLength} bytes; automatic download limit is ${params.maxBytes} bytes.`,
    );
  }

  const { fileName, mimeType } = fetched;
  const saved = await saveSlackAttachmentStream({
    accountId: params.accountId,
    fileName,
    body: fetched.body,
    maxBytes: params.maxBytes,
    signal: params.signal,
  });

  const kind = resolveAttachmentKind(mimeType);
  // Images are deliberately NOT inlined as base64 (no imageDataBase64):
  // attachments are saved to disk and surfaced via local_path in the channel
  // notification, so the agent Reads them on demand through the shared image
  // resize seam. Inlining every attachment let per-image-legal payloads
  // accumulate past the inference gateway's request byte limit (LET-9517,
  // LET-9501).
  const attachment: ChannelMessageAttachment = {
    id: params.file.id,
    name: fileName,
    mimeType,
    sizeBytes: saved.sizeBytes,
    kind,
    localPath: saved.localPath,
    sourceMessageId: params.sourceMessageId,
    ...(params.sourceThreadId ? { sourceThreadId: params.sourceThreadId } : {}),
  };

  // Slack voice memos arrive as ordinary audio files/file_share events, so the
  // opt-in applies to inbound audio attachments generally.
  if (kind === "audio" && params.transcribeVoice) {
    const { isTranscriptionConfigured, transcribeAudioFile } = await import(
      "@/channels/transcription/index"
    );
    if (isTranscriptionConfigured()) {
      const result = await transcribeAudioFile(saved.localPath);
      if (result.success && result.text) {
        attachment.transcription = result.text;
      } else if (result.error) {
        attachment.transcriptionError = result.error;
        console.warn(
          `[Slack] Audio transcription failed for ${fileName}:`,
          result.error,
        );
      }
    } else {
      attachment.transcriptionError =
        "OPENAI_API_KEY not set; transcription skipped.";
    }
  }

  return attachment;
}

async function resolveSlackFilesAsAttachments(params: {
  accountId: string;
  token: string;
  files: SlackFileLike[];
  sourceMessageId?: string;
  sourceThreadId?: string | null;
  transcribeVoice?: boolean;
}): Promise<ChannelMessageAttachment[]> {
  if (params.files.length === 0) {
    return [];
  }

  const resolved = await Promise.all(
    params.files.map(async (file) => {
      try {
        return await materializeSlackAttachment({
          accountId: params.accountId,
          token: params.token,
          file,
          sourceMessageId: params.sourceMessageId,
          sourceThreadId: params.sourceThreadId,
          maxBytes: MAX_SLACK_ATTACHMENT_BYTES,
          transcribeVoice: params.transcribeVoice,
        });
      } catch (error) {
        const reason =
          error instanceof SlackAttachmentDownloadError
            ? error.reason
            : "download_failed";
        return createUndownloadedSlackAttachment({
          file,
          sourceMessageId: params.sourceMessageId,
          sourceThreadId: params.sourceThreadId,
          reason,
        });
      }
    }),
  );

  return resolved;
}

function resolveSlackThreadAttachmentOptions(
  params: SlackThreadAttachmentParams,
): SlackThreadAttachmentOptions | undefined {
  if (!isNonEmptyString(params.accountId) || !isNonEmptyString(params.token)) {
    return undefined;
  }

  return {
    accountId: params.accountId,
    token: params.token,
    transcribeVoice: params.transcribeVoice,
  };
}

function hasSlackThreadMessageContent(
  message: SlackRepliesPageMessage,
  attachmentOptions?: SlackThreadAttachmentOptions,
): boolean {
  if (resolveSlackThreadMessageText(message)) {
    return true;
  }
  return Boolean(attachmentOptions && collectSlackFiles(message).length > 0);
}

function hasHydratedSlackThreadMessageContent(
  message: SlackThreadMessage,
): boolean {
  return message.text.length > 0 || Boolean(message.attachments?.length);
}

async function resolveSlackMessageAttachments(
  message: SlackRepliesPageMessage,
  attachmentOptions?: SlackThreadAttachmentOptions,
  sourceThreadId?: string,
): Promise<ChannelMessageAttachment[]> {
  if (!attachmentOptions) {
    return [];
  }

  return resolveSlackFilesAsAttachments({
    accountId: attachmentOptions.accountId,
    token: attachmentOptions.token,
    files: collectSlackFiles(message),
    sourceMessageId: message.ts,
    sourceThreadId:
      sourceThreadId ??
      (isNonEmptyString(message.thread_ts) ? message.thread_ts : null),
    transcribeVoice: attachmentOptions.transcribeVoice,
  });
}

export async function resolveSlackInboundAttachments(params: {
  accountId: string;
  token: string;
  rawEvent: unknown;
  transcribeVoice?: boolean;
}): Promise<ChannelMessageAttachment[]> {
  const rawEvent = asRecord(params.rawEvent);
  return resolveSlackFilesAsAttachments({
    accountId: params.accountId,
    token: params.token,
    files: collectSlackFiles(params.rawEvent),
    sourceMessageId: isNonEmptyString(rawEvent?.ts) ? rawEvent.ts : undefined,
    sourceThreadId: isNonEmptyString(rawEvent?.thread_ts)
      ? rawEvent.thread_ts
      : null,
    transcribeVoice: params.transcribeVoice,
  });
}

export async function resolveSlackCurrentMessageAttachments(
  params: {
    channelId: string;
    threadTs: string;
    messageTs: string;
    client: SlackAttachmentReadClient;
  } & SlackThreadAttachmentParams,
): Promise<ChannelMessageAttachment[]> {
  const attachmentOptions = resolveSlackThreadAttachmentOptions(params);
  if (!attachmentOptions) {
    return [];
  }

  try {
    const files = await resolveSlackMessageFiles({
      channelId: params.channelId,
      threadTs: params.threadTs,
      messageTs: params.messageTs,
      client: params.client,
    });
    return files
      ? resolveSlackFilesAsAttachments({
          accountId: attachmentOptions.accountId,
          token: attachmentOptions.token,
          files,
          sourceMessageId: params.messageTs,
          sourceThreadId: params.threadTs,
          transcribeVoice: attachmentOptions.transcribeVoice,
        })
      : [];
  } catch {
    return [];
  }
}

export async function readSlackAttachmentFile(
  localPath: string,
): Promise<Buffer> {
  return readFile(localPath);
}

export async function resolveSlackThreadStarter(
  params: {
    channelId: string;
    threadTs: string;
    client: SlackAttachmentReadClient;
  } & SlackThreadAttachmentParams,
): Promise<SlackThreadMessage | null> {
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as SlackRepliesPage;

    const message = response.messages?.[0];
    if (!message) {
      return null;
    }

    const attachmentOptions = resolveSlackThreadAttachmentOptions(params);
    if (!hasSlackThreadMessageContent(message, attachmentOptions)) {
      return null;
    }

    const mapped = await mapSlackThreadMessage(
      message,
      attachmentOptions,
      params.threadTs,
    );
    return hasHydratedSlackThreadMessageContent(mapped) ? mapped : null;
  } catch {
    return null;
  }
}

export async function resolveSlackThreadHistory(
  params: {
    channelId: string;
    threadTs: string;
    client: SlackAttachmentReadClient;
    currentMessageTs?: string;
    limit?: number;
    include?: SlackThreadHistoryEntryKind;
    excludeBotId?: string | null;
    routedBotUserId?: string | null;
    acceptMentionedBots?: boolean;
  } & SlackThreadAttachmentParams,
): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
  const attachmentOptions = resolveSlackThreadAttachmentOptions(params);
  let cursor: string | undefined;

  try {
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const message of response.messages ?? []) {
        if (params.currentMessageTs && message.ts === params.currentMessageTs) {
          continue;
        }
        if (message.ts === params.threadTs) {
          continue;
        }

        const isBotMessage = isNonEmptyString(message.bot_id);
        if (params.include === "unrouted-bot") {
          if (!isBotMessage) {
            retained.length = 0;
            continue;
          }
          if (
            isNonEmptyString(params.excludeBotId) &&
            message.bot_id === params.excludeBotId
          ) {
            continue;
          }
          if (
            params.acceptMentionedBots === true &&
            hasSlackMention(message.text ?? "", params.routedBotUserId ?? null)
          ) {
            retained.length = 0;
            continue;
          }
        }
        if (params.include === "bot" && !isNonEmptyString(message.bot_id)) {
          continue;
        }
        if (!hasSlackThreadMessageContent(message, attachmentOptions)) {
          continue;
        }

        retained.push(message);
        if (retained.length > maxMessages) {
          retained.shift();
        }
      }

      const nextCursor = response.response_metadata?.next_cursor;
      cursor =
        typeof nextCursor === "string" && nextCursor.trim().length > 0
          ? nextCursor.trim()
          : undefined;
    } while (cursor);

    const mapped = await Promise.all(
      retained.map((message) =>
        mapSlackThreadMessage(message, attachmentOptions, params.threadTs),
      ),
    );
    return mapped.filter(hasHydratedSlackThreadMessageContent);
  } catch {
    return [];
  }
}

export async function resolveSlackChannelHistory(
  params: {
    channelId: string;
    beforeTs: string;
    client: SlackAttachmentReadClient;
    limit?: number;
  } & SlackThreadAttachmentParams,
): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  const fetchLimit = Math.min(Math.max(maxMessages * 3, maxMessages), 100);
  const attachmentOptions = resolveSlackThreadAttachmentOptions(params);

  try {
    const response = (await params.client.conversations.history({
      channel: params.channelId,
      latest: params.beforeTs,
      inclusive: false,
      limit: fetchLimit,
    })) as SlackRepliesPage;

    const retained = (response.messages ?? [])
      .filter((message) => {
        if (message.ts === params.beforeTs) {
          return false;
        }

        return hasSlackThreadMessageContent(message, attachmentOptions);
      })
      .slice(0, fetchLimit)
      .reverse();

    const mapped = await Promise.all(
      retained
        .slice(-maxMessages)
        .map((message) => mapSlackThreadMessage(message, attachmentOptions)),
    );
    return mapped.filter(hasHydratedSlackThreadMessageContent);
  } catch {
    return [];
  }
}
