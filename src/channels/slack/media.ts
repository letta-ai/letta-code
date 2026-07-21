import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ChannelMessageAttachment } from "@/channels/types";
import {
  SlackAttachmentDownloadError,
  type SlackAttachmentDownloadFailureReason,
  saveSlackAttachmentStream,
} from "./attachment-stream";
import type {
  SlackAttachmentReadClient,
  SlackFileLike,
} from "./attachment-types";

const MAX_SLACK_ATTACHMENTS = 8;
const MAX_SLACK_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ALLOWED_SLACK_HOST_SUFFIXES = [
  "slack.com",
  "slack-edge.com",
  "slack-files.com",
] as const;

type SlackAttachmentLike = {
  text?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  title?: string;
  image_url?: string;
  files?: SlackFileLike[];
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

type SlackThreadHistoryEntryKind = "all" | "bot";

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

function normalizeSlackFileLike(value: unknown): SlackFileLike | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    id: isNonEmptyString(record.id) ? record.id : undefined,
    name: isNonEmptyString(record.name) ? record.name : undefined,
    mimetype: isNonEmptyString(record.mimetype) ? record.mimetype : undefined,
    size: typeof record.size === "number" ? record.size : undefined,
    url_private: isNonEmptyString(record.url_private)
      ? record.url_private
      : undefined,
    url_private_download: isNonEmptyString(record.url_private_download)
      ? record.url_private_download
      : undefined,
  };
}

function normalizeSlackAttachmentLike(
  value: unknown,
): SlackAttachmentLike | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const files = Array.isArray(record.files)
    ? record.files
        .map((entry) => normalizeSlackFileLike(entry))
        .filter((entry): entry is SlackFileLike => Boolean(entry))
    : undefined;

  return {
    text: isNonEmptyString(record.text) ? record.text : undefined,
    fallback: isNonEmptyString(record.fallback) ? record.fallback : undefined,
    pretext: isNonEmptyString(record.pretext) ? record.pretext : undefined,
    author_name: isNonEmptyString(record.author_name)
      ? record.author_name
      : undefined,
    title: isNonEmptyString(record.title) ? record.title : undefined,
    image_url: isNonEmptyString(record.image_url)
      ? record.image_url
      : undefined,
    files,
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

  const files = Array.isArray(message.files)
    ? message.files
        .map((entry) => normalizeSlackFileLike(entry))
        .filter((entry): entry is SlackFileLike => Boolean(entry))
    : [];

  if (files.length === 0) {
    return "";
  }

  const fileNames = files.map((file) => file.name ?? "file").join(", ");
  return `[attached: ${fileNames}]`;
}

function isAllowedSlackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return ALLOWED_SLACK_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function assertSlackFileUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`Unsupported Slack file protocol: ${parsed.protocol}`);
  }
  if (!isAllowedSlackHostname(parsed.hostname)) {
    throw new Error(`Refusing non-Slack attachment host: ${parsed.hostname}`);
  }
  return parsed;
}

function extensionForMimeType(mimeType?: string): string {
  switch (mimeType?.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/aac":
      return ".aac";
    case "audio/m4a":
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function resolveMimeType(name: string, fallback?: string): string | undefined {
  if (fallback) {
    return fallback;
  }

  switch (extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".aac":
      return "audio/aac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".oga":
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return undefined;
  }
}

function isGenericSlackMimeType(mimeType?: string): boolean {
  const normalized = mimeType?.trim().toLowerCase();
  return (
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream"
  );
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

async function fetchWithSlackAuth(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<Response> {
  const parsed = assertSlackFileUrl(url);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const initial = await fetch(parsed.href, {
    headers: authHeaders,
    redirect: "manual",
    ...(signal ? { signal } : {}),
  });

  if (initial.status < 300 || initial.status >= 400) {
    return initial;
  }

  const redirectUrl = initial.headers.get("location");
  if (!redirectUrl) {
    return initial;
  }

  const resolved = new URL(redirectUrl, parsed.href);
  if (resolved.origin === parsed.origin) {
    return fetch(resolved.href, {
      headers: authHeaders,
      redirect: "follow",
      ...(signal ? { signal } : {}),
    });
  }

  return fetch(resolved.href, {
    redirect: "follow",
    ...(signal ? { signal } : {}),
  });
}

function resolveSlackAttachmentFileName(params: {
  file: SlackFileLike;
  url?: string;
  mimeType?: string;
}): string {
  const hintedName =
    params.file.name ??
    (params.url ? basename(new URL(params.url).pathname) : undefined) ??
    `${params.file.id ?? "attachment"}${extensionForMimeType(params.file.mimetype)}`;
  return extname(hintedName) || !params.mimeType
    ? hintedName
    : `${hintedName}${extensionForMimeType(params.mimeType)}`;
}

function resolveSlackAttachmentMimeType(params: {
  file: SlackFileLike;
  fileName: string;
  responseMimeType?: string;
}): string | undefined {
  const preferredMimeType =
    params.responseMimeType && !isGenericSlackMimeType(params.responseMimeType)
      ? params.responseMimeType
      : params.file.mimetype && !isGenericSlackMimeType(params.file.mimetype)
        ? params.file.mimetype
        : undefined;
  return resolveMimeType(params.fileName, preferredMimeType);
}

function createUndownloadedSlackAttachment(params: {
  file: SlackFileLike;
  sourceMessageId?: string;
  sourceThreadId?: string | null;
  reason: SlackAttachmentDownloadFailureReason;
}): ChannelMessageAttachment {
  const fileName = resolveSlackAttachmentFileName({ file: params.file });
  const mimeType = resolveSlackAttachmentMimeType({
    file: params.file,
    fileName,
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

  const response = await fetchWithSlackAuth(
    url,
    params.token,
    params.signal,
  ).catch((error) => {
    throw new SlackAttachmentDownloadError(
      "download_failed",
      error instanceof Error ? error.message : "Slack attachment fetch failed.",
    );
  });
  if (!response.ok) {
    throw new SlackAttachmentDownloadError(
      "download_failed",
      `Slack attachment fetch failed with HTTP ${response.status}.`,
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number(contentLengthHeader)
    : undefined;
  if (
    params.maxBytes !== undefined &&
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > params.maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new SlackAttachmentDownloadError(
      "exceeds_auto_download_limit",
      `Slack attachment is ${contentLength} bytes; automatic download limit is ${params.maxBytes} bytes.`,
    );
  }

  const responseMimeType =
    response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
  const hintedName = resolveSlackAttachmentFileName({
    file: params.file,
    url,
  });
  const mimeType = resolveSlackAttachmentMimeType({
    file: params.file,
    fileName: hintedName,
    responseMimeType,
  });
  const fileName = resolveSlackAttachmentFileName({
    file: params.file,
    url,
    mimeType,
  });
  if (!response.body) {
    throw new SlackAttachmentDownloadError(
      "download_failed",
      "Slack attachment response did not include a body.",
    );
  }
  const saved = await saveSlackAttachmentStream({
    accountId: params.accountId,
    fileName,
    body: response.body,
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

export function collectSlackFiles(rawEvent: unknown): SlackFileLike[] {
  const record = asRecord(rawEvent);
  if (!record) {
    return [];
  }

  const deduped = new Map<string, SlackFileLike>();

  const push = (file: SlackFileLike | null) => {
    if (!file) {
      return;
    }
    const key =
      file.id ??
      file.url_private_download ??
      file.url_private ??
      `${file.name ?? "attachment"}:${file.mimetype ?? ""}`;
    deduped.set(key, file);
  };

  if (Array.isArray(record.files)) {
    for (const entry of record.files) {
      push(normalizeSlackFileLike(entry));
    }
  }

  if (Array.isArray(record.attachments)) {
    record.attachments
      .map((entry) => normalizeSlackAttachmentLike(entry))
      .filter((entry): entry is SlackAttachmentLike => Boolean(entry))
      .forEach((attachment, index) => {
        for (const file of attachment.files ?? []) {
          push(file);
        }
        if (attachment.image_url) {
          push({
            id: `attachment-image-${index}`,
            name: `attachment-image-${index}.png`,
            url_private: attachment.image_url,
          });
        }
      });
  }

  return Array.from(deduped.values()).slice(0, MAX_SLACK_ATTACHMENTS);
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

  const fetchLimit = 200;
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

      const message = (response.messages ?? []).find(
        (entry) => entry.ts === params.messageTs,
      );
      if (message) {
        return resolveSlackMessageAttachments(
          message,
          attachmentOptions,
          params.threadTs,
        );
      }

      const nextCursor = response.response_metadata?.next_cursor;
      cursor =
        typeof nextCursor === "string" && nextCursor.trim().length > 0
          ? nextCursor.trim()
          : undefined;
    } while (cursor);
  } catch {
    return [];
  }

  return [];
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
        if (params.include === "bot" && !isNonEmptyString(message.bot_id)) {
          continue;
        }
        if (!hasSlackThreadMessageContent(message, attachmentOptions)) {
          continue;
        }
        if (params.currentMessageTs && message.ts === params.currentMessageTs) {
          continue;
        }
        if (message.ts === params.threadTs) {
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
