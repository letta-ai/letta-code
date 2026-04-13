/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 * Reference: lettabot src/channels/telegram.ts
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot as GrammYBot, Context as GrammYContext } from "grammy";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  InboundImageAttachment,
  OutboundChannelMessage,
  TelegramChannelConfig,
} from "../types";
import { loadGrammyModule } from "./runtime";

const SAFE_CHARS_RE = /[^A-Za-z0-9._-]/g;

/**
 * Save an image buffer to a temp directory and return the absolute path.
 * Structure: <tmpdir>/letta-attachments/telegram/<chatId>/<timestamp>-<uuid>-<name>
 */
function saveImageToTemp(
  buffer: Buffer,
  chatId: string,
  fileName: string,
): string {
  const dir = join(
    tmpdir(),
    "letta-attachments",
    "telegram",
    chatId.replace(SAFE_CHARS_RE, "_"),
  );
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const token = randomUUID().slice(0, 8);
  const safeName = fileName.replace(SAFE_CHARS_RE, "_") || "image";
  const filePath = join(dir, `${stamp}-${token}-${safeName}`);
  writeFileSync(filePath, buffer);
  return filePath;
}

type TelegramBot = GrammYBot<GrammYContext>;
type GrammYModule = typeof import("grammy") & {
  default?: Partial<typeof import("grammy")>;
};
type TelegramBotConstructor = typeof import("grammy").Bot;

function resolveTelegramBotConstructor(
  mod: GrammYModule,
): TelegramBotConstructor {
  const Bot = mod.Bot ?? mod.default?.Bot;
  if (!Bot) {
    throw new Error('Installed Telegram runtime did not export "Bot".');
  }
  return Bot as TelegramBotConstructor;
}

export function createTelegramAdapter(
  config: TelegramChannelConfig,
): ChannelAdapter {
  let bot: TelegramBot | null = null;
  let running = false;

  async function ensureBot(): Promise<TelegramBot> {
    if (bot) {
      return bot;
    }

    const grammy = await loadGrammyModule();
    const Bot = resolveTelegramBotConstructor(grammy);
    const instance = new Bot(config.token);

    instance.catch((error) => {
      const updateId = error.ctx?.update?.update_id;
      const prefix =
        updateId === undefined
          ? "[Telegram] Unhandled bot error:"
          : `[Telegram] Unhandled bot error for update ${updateId}:`;
      console.error(prefix, error.error);
    });

    instance.on("message:text", async (ctx) => {
      const msg = ctx.message;
      if (!msg.text || !msg.from) {
        return;
      }

      const displayName =
        msg.from.username ??
        [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");

      const inbound: InboundChannelMessage = {
        channel: "telegram",
        chatId: String(msg.chat.id),
        senderId: String(msg.from.id),
        senderName: displayName || undefined,
        text: msg.text,
        timestamp: msg.date * 1000,
        messageId: String(msg.message_id),
        chatType: "direct",
        raw: msg,
      };

      if (adapter.onMessage) {
        try {
          await adapter.onMessage(inbound);
        } catch (err) {
          console.error("[Telegram] Error handling inbound message:", err);
        }
      }
    });

    // Handle photo messages (and image documents)
    // Match the desktop app's 5MB limit (see imageResize.ts).
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const FETCH_TIMEOUT_MS = 15_000;

    instance.on(["message:photo", "message:document"], async (ctx) => {
      const msg = ctx.message;
      if (!msg.from) return;

      // Determine if this is a photo or an image document
      const photos = msg.photo ?? [];
      const isPhoto = photos.length > 0;
      const doc = msg.document;
      const isImageDoc = !!doc?.mime_type?.startsWith("image/");
      if (!isPhoto && !isImageDoc) return;

      const displayName =
        msg.from.username ??
        [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");

      // Download the image
      const images: InboundImageAttachment[] = [];
      try {
        let fileId: string;
        let mediaType: string;
        let reportedSize: number | undefined;

        if (isPhoto) {
          // Use the largest photo size (last in array).
          // isPhoto guarantees photos.length > 0, so the index is safe.
          const photo = photos[photos.length - 1] as (typeof photos)[number];
          fileId = photo.file_id;
          mediaType = "image/jpeg"; // Telegram photos are always JPEG
          reportedSize = photo.file_size;
        } else {
          fileId = doc!.file_id;
          mediaType = doc!.mime_type ?? "image/jpeg";
          reportedSize = doc!.file_size;
        }

        // Skip oversized files before downloading
        if (reportedSize && reportedSize > MAX_IMAGE_BYTES) {
          console.warn(
            `[Telegram] Image too large (${(reportedSize / 1024 / 1024).toFixed(1)}MB), skipping download.`,
          );
        } else {
          const file = await instance.api.getFile(fileId);
          if (file.file_path) {
            // Note: Telegram Bot API requires the token in the download URL.
            // We avoid logging the URL to prevent token leakage.
            const fileUrl = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
            let response: Response;
            try {
              response = await fetch(fileUrl, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
              });
            } catch (fetchErr) {
              // Log without the URL to avoid leaking the bot token
              console.error("[Telegram] Failed to fetch image file.");
              throw fetchErr;
            }
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              if (buffer.byteLength <= MAX_IMAGE_BYTES) {
                const base64 = buffer.toString("base64");
                // Derive a reasonable filename for the temp file
                const ext = mediaType.split("/")[1] ?? "jpg";
                const baseName = isPhoto
                  ? `photo.${ext}`
                  : (doc?.file_name ?? `image.${ext}`);
                let localPath: string | undefined;
                try {
                  localPath = saveImageToTemp(
                    buffer,
                    String(msg.chat.id),
                    baseName,
                  );
                } catch {
                  // Non-fatal: agent still gets the base64 image
                }
                images.push({ data: base64, mediaType, localPath });
              } else {
                console.warn(
                  `[Telegram] Downloaded image too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB), discarding.`,
                );
              }
            }
          }
        }
      } catch (err) {
        // Intentionally terse to avoid leaking the bot token from URLs in error messages
        const errMsg = err instanceof Error ? err.message : "unknown error";
        console.error(`[Telegram] Failed to download image: ${errMsg}`);
      }

      // If we couldn't download the image, still forward the caption if present
      if (images.length === 0 && !msg.caption) return;

      const inbound: InboundChannelMessage = {
        channel: "telegram",
        chatId: String(msg.chat.id),
        senderId: String(msg.from.id),
        senderName: displayName || undefined,
        text: msg.caption ?? "",
        timestamp: msg.date * 1000,
        messageId: String(msg.message_id),
        chatType: "direct",
        raw: msg,
        images: images.length > 0 ? images : undefined,
      };

      if (adapter.onMessage) {
        try {
          await adapter.onMessage(inbound);
        } catch (err) {
          console.error("[Telegram] Error handling inbound photo:", err);
        }
      }
    });

    instance.command("start", async (ctx) => {
      await ctx.reply(
        "Welcome! This bot is connected to Letta Code.\n\n" +
          "If this is your first time, send any message and you'll " +
          "receive a pairing code to connect to an agent.",
      );
    });

    instance.command("status", async (ctx) => {
      const botInfo = instance.botInfo;
      await ctx.reply(
        `Bot: @${botInfo.username ?? "unknown"}\n` +
          "Status: Running\n" +
          `DM Policy: ${config.dmPolicy}`,
      );
    });

    bot = instance;
    return instance;
  }

  const adapter: ChannelAdapter = {
    id: "telegram",
    name: "Telegram",

    async start(): Promise<void> {
      if (running) return;
      const telegramBot = await ensureBot();

      await telegramBot.init();
      const info = telegramBot.botInfo;
      console.log(
        `[Telegram] Bot started as @${info.username} (dm_policy: ${config.dmPolicy})`,
      );

      await new Promise<void>((resolve, reject) => {
        let started = false;

        void telegramBot
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
      if (!running || !bot) return;
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
      const telegramBot = await ensureBot();
      const opts: Record<string, unknown> = {};
      if (msg.replyToMessageId) {
        opts.reply_parameters = {
          message_id: Number(msg.replyToMessageId),
        };
      }
      if (msg.parseMode) {
        opts.parse_mode = msg.parseMode;
      }

      const result = await telegramBot.api.sendMessage(
        msg.chatId,
        msg.text,
        opts,
      );
      return { messageId: String(result.message_id) };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      const telegramBot = await ensureBot();
      const reply_parameters = options?.replyToMessageId
        ? {
            message_id: Number(options.replyToMessageId),
          }
        : undefined;
      await telegramBot.api.sendMessage(
        chatId,
        text,
        reply_parameters ? { reply_parameters } : {},
      );
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
  const grammy = await loadGrammyModule();
  const Bot = resolveTelegramBotConstructor(grammy);
  const bot = new Bot(token);
  await bot.init();
  const info = bot.botInfo;
  return {
    username: info.username ?? "",
    id: info.id,
  };
}
