/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 * Reference: lettabot src/channels/telegram.ts
 */

import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelConfig,
} from "../types";
import { loadGrammyModule } from "./runtime";

type TelegramBotInfo = { username?: string; id: number };
type TelegramCatchError = {
  ctx?: { update?: { update_id?: number } };
  error: unknown;
};
type TelegramReplyContext = { reply(text: string): Promise<unknown> };
type TelegramTextMessage = {
  text?: string;
  chat: { id: string | number };
  from: {
    id: string | number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  date: number;
  message_id: string | number;
};
type TelegramMessageContext = TelegramReplyContext & {
  message: TelegramTextMessage;
};
type TelegramBot = {
  botInfo: TelegramBotInfo;
  api: {
    sendMessage(
      chatId: string,
      text: string,
      opts?: Record<string, unknown>,
    ): Promise<{ message_id: string | number }>;
  };
  catch(handler: (error: TelegramCatchError) => unknown): void;
  on(
    filter: string,
    handler: (ctx: TelegramMessageContext) => Promise<void>,
  ): void;
  command(
    command: string,
    handler: (ctx: TelegramReplyContext) => Promise<void>,
  ): void;
  init(): Promise<void>;
  start(options?: {
    onStart?: (botInfo: TelegramBotInfo) => void | Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
};
type TelegramBotConstructor = new (token: string) => TelegramBot;
type GrammYModule = {
  Bot?: TelegramBotConstructor;
  default?: { Bot?: TelegramBotConstructor };
};

function resolveTelegramBotConstructor(
  mod: GrammYModule,
): TelegramBotConstructor {
  const Bot = mod.Bot ?? mod.default?.Bot;
  if (!Bot) {
    throw new Error('Installed Telegram runtime did not export "Bot".');
  }
  return Bot;
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

    const grammy = await loadGrammyModule<GrammYModule>();
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
      if (!msg.text) return;

      const inbound: InboundChannelMessage = {
        channel: "telegram",
        chatId: String(msg.chat.id),
        senderId: String(msg.from.id),
        senderName:
          msg.from.username ??
          [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
        text: msg.text,
        timestamp: msg.date * 1000,
        messageId: String(msg.message_id),
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
          `Status: Running\n` +
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

      // Fetch bot info first (validates the token)
      await telegramBot.init();
      const info = telegramBot.botInfo;
      console.log(
        `[Telegram] Bot started as @${info.username} (dm_policy: ${config.dmPolicy})`,
      );

      // Wait until grammY confirms polling has started so live status queries
      // can report a real running state immediately after channel_start.
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

    async sendDirectReply(chatId: string, text: string): Promise<void> {
      const telegramBot = await ensureBot();
      await telegramBot.api.sendMessage(chatId, text);
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
  const grammy = await loadGrammyModule<GrammYModule>();
  const Bot = resolveTelegramBotConstructor(grammy);
  const bot = new Bot(token);
  await bot.init();
  const info = bot.botInfo;
  return {
    username: info.username ?? "",
    id: info.id,
  };
}
