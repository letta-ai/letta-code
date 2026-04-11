/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 * Reference: lettabot src/channels/telegram.ts
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { Bot } from "grammy";
import { getChannelInboundMediaDir } from "../config";
import type {
  ChannelAdapter,
  InboundChannelAttachment,
  InboundChannelAttachmentKind,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelConfig,
} from "../types";

const DEFAULT_MEDIA_GROUP_FLUSH_MS = 150;
const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

type TelegramAdapterDeps = {
  fetchImpl?: typeof fetch;
  mediaGroupFlushMs?: number;
  resolveInboundMediaDir?: (chatId: string) => string;
  now?: () => Date;
  randomToken?: () => string;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

type TelegramLikeMessage = {
  media_group_id?: string;
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number | string };
  from: {
    id: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  animation?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
    is_animated?: boolean;
    is_video?: boolean;
  };
};

type TelegramAttachmentCandidate = {
  fileId: string;
  kind: InboundChannelAttachmentKind;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
};

type BufferedMediaGroup = {
  messages: TelegramLikeMessage[];
  timer: ReturnType<typeof setTimeout>;
};

function normalizeMimeType(mimeType?: string): string | undefined {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function sanitizePathSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "attachment";
}

function coerceSizeBytes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function inferAttachmentKind(params: {
  mimeType?: string;
  fileName?: string;
  fallback: InboundChannelAttachmentKind;
}): InboundChannelAttachmentKind {
  const normalizedMimeType = normalizeMimeType(params.mimeType);
  if (normalizedMimeType?.startsWith("image/")) {
    return "image";
  }
  if (normalizedMimeType?.startsWith("audio/")) {
    return "audio";
  }
  if (normalizedMimeType?.startsWith("video/")) {
    return "video";
  }

  const lowerName = params.fileName?.toLowerCase();
  if (lowerName) {
    for (const ext of IMAGE_FILE_EXTENSIONS) {
      if (lowerName.endsWith(ext)) {
        return "image";
      }
    }
  }

  return params.fallback;
}

function extractMessageText(message: TelegramLikeMessage): string {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

function getSenderName(message: TelegramLikeMessage): string | undefined {
  return (
    message.from.username ??
    ([message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ") ||
      undefined)
  );
}

function collectAttachmentCandidates(
  message: TelegramLikeMessage,
): TelegramAttachmentCandidate[] {
  const attachments: TelegramAttachmentCandidate[] = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    if (photo?.file_id) {
      attachments.push({
        fileId: photo.file_id,
        kind: "image",
        name: `photo-${photo.file_unique_id ?? photo.file_id}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: coerceSizeBytes(photo.file_size),
      });
    }
  }

  if (message.document?.file_id) {
    attachments.push({
      fileId: message.document.file_id,
      kind: inferAttachmentKind({
        mimeType: message.document.mime_type,
        fileName: message.document.file_name,
        fallback: "file",
      }),
      name: message.document.file_name,
      mimeType: message.document.mime_type,
      sizeBytes: coerceSizeBytes(message.document.file_size),
    });
  }

  if (message.video?.file_id) {
    attachments.push({
      fileId: message.video.file_id,
      kind: "video",
      name:
        message.video.file_name ??
        `video-${message.video.file_unique_id ?? message.video.file_id}.mp4`,
      mimeType: message.video.mime_type,
      sizeBytes: coerceSizeBytes(message.video.file_size),
    });
  }

  if (message.audio?.file_id) {
    attachments.push({
      fileId: message.audio.file_id,
      kind: "audio",
      name:
        message.audio.file_name ??
        `audio-${message.audio.file_unique_id ?? message.audio.file_id}.mp3`,
      mimeType: message.audio.mime_type,
      sizeBytes: coerceSizeBytes(message.audio.file_size),
    });
  }

  if (message.voice?.file_id) {
    attachments.push({
      fileId: message.voice.file_id,
      kind: "audio",
      name: `voice-${message.voice.file_unique_id ?? message.voice.file_id}.ogg`,
      mimeType: message.voice.mime_type,
      sizeBytes: coerceSizeBytes(message.voice.file_size),
    });
  }

  if (message.animation?.file_id) {
    attachments.push({
      fileId: message.animation.file_id,
      kind: inferAttachmentKind({
        mimeType: message.animation.mime_type,
        fileName: message.animation.file_name,
        fallback: "video",
      }),
      name:
        message.animation.file_name ??
        `animation-${message.animation.file_unique_id ?? message.animation.file_id}.mp4`,
      mimeType: message.animation.mime_type,
      sizeBytes: coerceSizeBytes(message.animation.file_size),
    });
  }

  if (
    message.sticker?.file_id &&
    !message.sticker.is_animated &&
    !message.sticker.is_video
  ) {
    attachments.push({
      fileId: message.sticker.file_id,
      kind: "image",
      name: `sticker-${message.sticker.file_unique_id ?? message.sticker.file_id}.webp`,
      mimeType: message.sticker.mime_type ?? "image/webp",
      sizeBytes: coerceSizeBytes(message.sticker.file_size),
    });
  }

  return attachments;
}

export function createTelegramAdapter(
  config: TelegramChannelConfig,
  deps: TelegramAdapterDeps = {},
): ChannelAdapter {
  const bot = new Bot(config.token);
  let running = false;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const mediaGroupFlushMs =
    deps.mediaGroupFlushMs ?? DEFAULT_MEDIA_GROUP_FLUSH_MS;
  const resolveInboundMediaDir =
    deps.resolveInboundMediaDir ??
    (() => getChannelInboundMediaDir("telegram"));
  const now = deps.now ?? (() => new Date());
  const randomToken = deps.randomToken ?? (() => randomUUID().slice(0, 8));
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  const bufferedMediaGroups = new Map<string, BufferedMediaGroup>();

  bot.catch((error) => {
    const updateId = error.ctx?.update?.update_id;
    const prefix =
      updateId === undefined
        ? "[Telegram] Unhandled bot error:"
        : `[Telegram] Unhandled bot error for update ${updateId}:`;
    console.error(prefix, error.error);
  });

  async function downloadAttachment(
    candidate: TelegramAttachmentCandidate,
    chatId: string,
  ): Promise<InboundChannelAttachment> {
    const attachment: InboundChannelAttachment = {
      kind: candidate.kind,
      name: candidate.name,
      mimeType: normalizeMimeType(candidate.mimeType),
      sizeBytes: candidate.sizeBytes,
    };

    if (
      typeof candidate.sizeBytes === "number" &&
      candidate.sizeBytes > DEFAULT_ATTACHMENT_MAX_BYTES
    ) {
      console.warn(
        `[Telegram] Skipping download for ${candidate.name ?? candidate.fileId}: attachment exceeds ${DEFAULT_ATTACHMENT_MAX_BYTES} bytes`,
      );
      return attachment;
    }

    try {
      const file = await bot.api.getFile(candidate.fileId);
      const remotePath = file.file_path;
      if (!remotePath) {
        return attachment;
      }

      const url = `https://api.telegram.org/file/bot${config.token}/${remotePath}`;
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`download failed (${response.status})`);
      }

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (
          Number.isFinite(contentLength) &&
          contentLength > DEFAULT_ATTACHMENT_MAX_BYTES
        ) {
          throw new Error(
            `download exceeds max size (${contentLength} > ${DEFAULT_ATTACHMENT_MAX_BYTES})`,
          );
        }
      }

      const fileBuffer = Buffer.from(await response.arrayBuffer());
      if (fileBuffer.byteLength > DEFAULT_ATTACHMENT_MAX_BYTES) {
        throw new Error(
          `download exceeds max size (${fileBuffer.byteLength} > ${DEFAULT_ATTACHMENT_MAX_BYTES})`,
        );
      }

      const inboundRoot = resolveInboundMediaDir(chatId);
      const targetDir = join(inboundRoot, sanitizePathSegment(chatId));
      await fs.mkdir(targetDir, { recursive: true });

      const timestamp = now().toISOString().replace(/[:.]/g, "-");
      const safeName = sanitizePathSegment(
        candidate.name ?? basename(remotePath) ?? candidate.fileId,
      );
      const targetPath = join(
        targetDir,
        `${timestamp}-${randomToken()}-${safeName}`,
      );

      await fs.writeFile(targetPath, fileBuffer);
      attachment.localPath = targetPath;
      return attachment;
    } catch (error) {
      console.error(
        `[Telegram] Failed to download inbound attachment ${candidate.name ?? candidate.fileId}:`,
        error,
      );
      return attachment;
    }
  }

  async function buildInboundMessage(
    messages: TelegramLikeMessage[],
  ): Promise<InboundChannelMessage | null> {
    const primaryMessage =
      messages.find((message) => extractMessageText(message).length > 0) ??
      messages[0];
    if (!primaryMessage) {
      return null;
    }

    const candidates = messages.flatMap((message) =>
      collectAttachmentCandidates(message),
    );
    const attachments = await Promise.all(
      candidates.map((candidate) =>
        downloadAttachment(candidate, String(primaryMessage.chat.id)),
      ),
    );
    const text = extractMessageText(primaryMessage);

    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    return {
      channel: "telegram",
      chatId: String(primaryMessage.chat.id),
      senderId: String(primaryMessage.from.id),
      senderName: getSenderName(primaryMessage),
      text,
      timestamp: primaryMessage.date * 1000,
      messageId: String(primaryMessage.message_id),
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: messages.length === 1 ? primaryMessage : messages,
    };
  }

  async function emitInboundMessages(
    messages: TelegramLikeMessage[],
  ): Promise<void> {
    const inbound = await buildInboundMessage(messages);
    if (!inbound || !adapter.onMessage) {
      return;
    }

    try {
      await adapter.onMessage(inbound);
    } catch (error) {
      console.error("[Telegram] Error handling inbound message:", error);
    }
  }

  function scheduleBufferedMediaGroupFlush(mediaGroupId: string): void {
    const entry = bufferedMediaGroups.get(mediaGroupId);
    if (!entry) {
      return;
    }

    clearTimeoutImpl(entry.timer);
    entry.timer = setTimeoutImpl(async () => {
      bufferedMediaGroups.delete(mediaGroupId);
      await emitInboundMessages(entry.messages);
    }, mediaGroupFlushMs);
  }

  // Wire message handlers
  bot.on("message", async (ctx) => {
    const message = ctx.message as TelegramLikeMessage | undefined;
    if (!message) {
      return;
    }

    const mediaGroupId =
      typeof message.media_group_id === "string"
        ? message.media_group_id
        : null;
    if (mediaGroupId) {
      const existing = bufferedMediaGroups.get(mediaGroupId);
      if (existing) {
        existing.messages.push(message);
        scheduleBufferedMediaGroupFlush(mediaGroupId);
      } else {
        bufferedMediaGroups.set(mediaGroupId, {
          messages: [message],
          timer: setTimeoutImpl(() => undefined, mediaGroupFlushMs),
        });
        scheduleBufferedMediaGroupFlush(mediaGroupId);
      }
      return;
    }

    await emitInboundMessages([message]);
  });

  // Basic bot commands
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome! This bot is connected to Letta Code.\n\n" +
        "If this is your first time, send any message and you'll " +
        "receive a pairing code to connect to an agent.",
    );
  });

  bot.command("status", async (ctx) => {
    const botInfo = bot.botInfo;
    await ctx.reply(
      `Bot: @${botInfo.username ?? "unknown"}\n` +
        `Status: Running\n` +
        `DM Policy: ${config.dmPolicy}`,
    );
  });

  const adapter: ChannelAdapter = {
    id: "telegram",
    name: "Telegram",

    async start(): Promise<void> {
      if (running) return;

      // Fetch bot info first (validates the token)
      await bot.init();
      const info = bot.botInfo;
      console.log(
        `[Telegram] Bot started as @${info.username} (dm_policy: ${config.dmPolicy})`,
      );

      // Wait until grammY confirms polling has started so live status queries
      // can report a real running state immediately after channel_start.
      await new Promise<void>((resolve, reject) => {
        let started = false;

        void bot
          .start({
            onStart: () => {
              running = true;
              started = true;
              resolve();
            },
          })
          .catch((error) => {
            running = false;

            if (!started) {
              reject(error);
              return;
            }

            console.error(
              "[Telegram] Long-polling stopped unexpectedly:",
              error,
            );
          });
      });
    },

    async stop(): Promise<void> {
      if (!running) return;
      for (const entry of bufferedMediaGroups.values()) {
        clearTimeoutImpl(entry.timer);
      }
      bufferedMediaGroups.clear();
      await bot.stop();
      running = false;
      console.log("[Telegram] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      const opts: Record<string, unknown> = {};
      if (msg.replyToMessageId) {
        opts.reply_parameters = {
          message_id: Number(msg.replyToMessageId),
        };
      }
      if (msg.parseMode) {
        opts.parse_mode = msg.parseMode;
      }

      const result = await bot.api.sendMessage(msg.chatId, msg.text, opts);
      return { messageId: String(result.message_id) };
    },

    async sendDirectReply(chatId: string, text: string): Promise<void> {
      await bot.api.sendMessage(chatId, text);
    },

    onMessage: undefined,
  };

  return adapter;
}

/**
 * Validate a Telegram bot token by calling getMe().
 * Returns the bot username on success, throws on failure.
 */
export async function validateTelegramToken(
  token: string,
): Promise<{ username: string; id: number }> {
  const bot = new Bot(token);
  await bot.init();
  const info = bot.botInfo;
  return {
    username: info.username ?? "",
    id: info.id,
  };
}
