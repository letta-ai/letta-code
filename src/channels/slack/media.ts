import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { getChannelDir } from "../config";
import type { ChannelMessageAttachment } from "../types";

const MAX_SLACK_ATTACHMENTS = 8;
const MAX_SLACK_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ALLOWED_SLACK_HOST_SUFFIXES = [
  "slack.com",
  "slack-edge.com",
  "slack-files.com",
] as const;

type SlackFileLike = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

type SlackAttachmentLike = {
  image_url?: string;
  files?: SlackFileLike[];
};

type SlackRepliesClient = {
  conversations: {
    history(args: {
      channel: string;
      latest?: string;
      limit?: number;
      inclusive?: boolean;
    }): Promise<unknown>;
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      inclusive?: boolean;
      cursor?: string;
    }): Promise<unknown>;
  };
};

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  files?: unknown[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

export type SlackThreadMessage = {
  text: string;
  userId?: string;
  botId?: string;
  ts?: string;
};

function mapSlackThreadMessage(
  message: SlackRepliesPageMessage,
): SlackThreadMessage {
  return {
    text: resolveSlackThreadMessageText(message),
    userId: isNonEmptyString(message.user) ? message.user : undefined,
    botId: isNonEmptyString(message.bot_id) ? message.bot_id : undefined,
    ts: isNonEmptyString(message.ts) ? message.ts : undefined,
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
    image_url: isNonEmptyString(record.image_url)
      ? record.image_url
      : undefined,
    files,
  };
}

function resolveSlackThreadMessageText(
  message: SlackRepliesPageMessage,
): string {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (text) {
    return text;
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

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[^\w.-]+/g, "_");
  return normalized.length > 0 ? normalized : "attachment";
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
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return undefined;
  }
}

async function fetchWithSlackAuth(
  url: string,
  token: string,
): Promise<Response> {
  const parsed = assertSlackFileUrl(url);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const initial = await fetch(parsed.href, {
    headers: authHeaders,
    redirect: "manual",
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
    });
  }

  return fetch(resolved.href, { redirect: "follow" });
}

async function saveSlackAttachment(params: {
  accountId: string;
  fileName: string;
  buffer: Buffer;
}): Promise<string> {
  const inboundDir = join(
    getChannelDir("slack"),
    "inbound",
    sanitizeFileName(params.accountId),
  );
  await mkdir(inboundDir, { recursive: true });

  const filePath = join(
    inboundDir,
    `${Date.now()}-${randomUUID()}-${sanitizeFileName(params.fileName)}`,
  );
  await writeFile(filePath, params.buffer);
  return filePath;
}

async function downloadSlackAttachment(params: {
  accountId: string;
  token: string;
  file: SlackFileLike;
}): Promise<ChannelMessageAttachment | null> {
  const url = params.file.url_private_download ?? params.file.url_private;
  if (!url) {
    return null;
  }

  const response = await fetchWithSlackAuth(url, params.token);
  if (!response.ok) {
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_SLACK_ATTACHMENT_BYTES) {
    return null;
  }

  const buffer = Buffer.from(arrayBuffer);
  const hintedName =
    params.file.name ??
    basename(new URL(url).pathname) ??
    `${params.file.id ?? "attachment"}${extensionForMimeType(params.file.mimetype)}`;
  const mimeType = resolveMimeType(
    hintedName,
    response.headers.get("content-type")?.split(";")[0] ?? params.file.mimetype,
  );
  const fileName =
    extname(hintedName) || !mimeType
      ? hintedName
      : `${hintedName}${extensionForMimeType(mimeType)}`;
  const localPath = await saveSlackAttachment({
    accountId: params.accountId,
    fileName,
    buffer,
  });

  const kind = mimeType?.startsWith("image/") ? "image" : "file";
  return {
    id: params.file.id,
    name: fileName,
    mimeType,
    sizeBytes: buffer.byteLength,
    kind,
    localPath,
    ...(kind === "image" ? { imageDataBase64: buffer.toString("base64") } : {}),
  };
}

function collectSlackFiles(rawEvent: unknown): SlackFileLike[] {
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

export async function resolveSlackInboundAttachments(params: {
  accountId: string;
  token: string;
  rawEvent: unknown;
}): Promise<ChannelMessageAttachment[]> {
  const files = collectSlackFiles(params.rawEvent);
  if (files.length === 0) {
    return [];
  }

  const resolved = await Promise.all(
    files.map((file) =>
      downloadSlackAttachment({
        accountId: params.accountId,
        token: params.token,
        file,
      }).catch(() => null),
    ),
  );

  return resolved.filter((attachment): attachment is ChannelMessageAttachment =>
    Boolean(attachment),
  );
}

export async function readSlackAttachmentFile(
  localPath: string,
): Promise<Buffer> {
  return readFile(localPath);
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackRepliesClient;
}): Promise<SlackThreadMessage | null> {
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

    const text = resolveSlackThreadMessageText(message);
    if (!text) {
      return null;
    }

    return {
      text,
      userId: isNonEmptyString(message.user) ? message.user : undefined,
      botId: isNonEmptyString(message.bot_id) ? message.bot_id : undefined,
      ts: isNonEmptyString(message.ts) ? message.ts : undefined,
    };
  } catch {
    return null;
  }
}

export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackRepliesClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
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
        const text = resolveSlackThreadMessageText(message);
        if (!text) {
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

    return retained.map(mapSlackThreadMessage);
  } catch {
    return [];
  }
}

export async function resolveSlackChannelHistory(params: {
  channelId: string;
  beforeTs: string;
  client: SlackRepliesClient;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  const fetchLimit = Math.min(Math.max(maxMessages * 3, maxMessages), 100);

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

        return Boolean(resolveSlackThreadMessageText(message));
      })
      .slice(0, fetchLimit)
      .reverse();

    return retained.slice(-maxMessages).map(mapSlackThreadMessage);
  } catch {
    return [];
  }
}
