/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 * Reference: lettabot src/channels/telegram.ts
 */

import { Bot } from "grammy";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelConfig,
} from "../types";

export function createTelegramAdapter(
  config: TelegramChannelConfig,
): ChannelAdapter {
  const bot = new Bot(config.token);
  let running = false;

  bot.catch((error) => {
    const updateId = error.ctx?.update?.update_id;
    const prefix =
      updateId === undefined
        ? "[Telegram] Unhandled bot error:"
        : `[Telegram] Unhandled bot error for update ${updateId}:`;
    console.error(prefix, error.error);
  });

  // Wire message handlers
  bot.on("message:text", async (ctx) => {
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

      // Start long-polling in background (non-blocking)
      void bot
        .start({
          onStart: () => {
            running = true;
          },
        })
        .catch((error) => {
          running = false;
          console.error("[Telegram] Long-polling stopped unexpectedly:", error);
        });
    },

    async stop(): Promise<void> {
      if (!running) return;
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
      const result = await bot.api.sendMessage(
        msg.chatId,
        msg.text,
        msg.replyToMessageId
          ? { reply_parameters: { message_id: Number(msg.replyToMessageId) } }
          : undefined,
      );
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
