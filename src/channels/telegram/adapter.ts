/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 */

import type { ReactionType, ReactionTypeEmoji } from "@grammyjs/types";
import type { Bot as GrammYBot, Context as GrammYContext } from "grammy";
import type {
  ChannelAdapter,
  ChannelApprovalEvent,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelAccount,
} from "../types";
import {
  detectTelegramUploadMethod,
  extractTelegramMessageText,
  getTelegramSenderName,
  resolveTelegramInboundAttachments,
  TELEGRAM_MEDIA_GROUP_FLUSH_MS,
  type TelegramLikeMessage,
} from "./media";
import { loadGrammyModule } from "./runtime";

type TelegramBot = GrammYBot<GrammYContext>;
type GrammYModule = typeof import("grammy") & {
  default?: Partial<typeof import("grammy")>;
};
type TelegramBotConstructor = typeof import("grammy").Bot;
type TelegramInputFileConstructor = typeof import("grammy").InputFile;
type BufferedMediaGroup = {
  messages: TelegramLikeMessage[];
  timer: ReturnType<typeof setTimeout>;
};
type TelegramReactionType =
  | {
      type?: "emoji";
      emoji?: string;
    }
  | {
      type?: "custom_emoji";
      custom_emoji_id?: string;
    }
  | {
      type?: "paid";
    };
type TelegramReactionUpdate = {
  chat: {
    id: string | number;
    type?: string;
    title?: string;
    username?: string;
  };
  message_id: string | number;
  user?: {
    id: string | number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  actor_chat?: {
    id: string | number;
    username?: string;
    title?: string;
  };
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
};
type TelegramApprovalCallbackPayload = {
  requestId: string;
  decision: "allow" | "deny";
};
type TelegramApprovalPromptState = {
  chatId: string;
  messageId: number;
  allowedSenderIds: Set<string>;
};

function resolveTelegramBotConstructor(
  mod: GrammYModule,
): TelegramBotConstructor {
  const Bot = mod.Bot ?? mod.default?.Bot;
  if (!Bot) {
    throw new Error('Installed Telegram runtime did not export "Bot".');
  }
  return Bot as TelegramBotConstructor;
}

function resolveTelegramInputFileConstructor(
  mod: GrammYModule,
): TelegramInputFileConstructor {
  const InputFile = mod.InputFile ?? mod.default?.InputFile;
  if (!InputFile) {
    throw new Error('Installed Telegram runtime did not export "InputFile".');
  }
  return InputFile as TelegramInputFileConstructor;
}

function buildTelegramReplyOptions(
  msg: Pick<
    OutboundChannelMessage,
    "replyToMessageId" | "parseMode" | "text" | "title"
  >,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (msg.replyToMessageId) {
    options.reply_parameters = {
      message_id: Number(msg.replyToMessageId),
    };
  }
  if (msg.text.trim().length > 0) {
    options.caption = msg.text;
    if (msg.parseMode) {
      options.parse_mode = msg.parseMode;
    }
  }
  if (msg.title?.trim()) {
    options.title = msg.title.trim();
  }
  return options;
}

function getTelegramReactionToken(
  reaction: TelegramReactionType,
): string | null {
  switch (reaction.type) {
    case "emoji":
      return reaction.emoji?.trim() || null;
    case "custom_emoji":
      return reaction.custom_emoji_id?.trim()
        ? `custom_emoji:${reaction.custom_emoji_id.trim()}`
        : null;
    case "paid":
      return "paid";
    default:
      return null;
  }
}

function parseTelegramReactionInput(reaction: string): ReactionType | null {
  const trimmed = reaction.trim();
  if (!trimmed) {
    return null;
  }

  const customEmojiPrefix = "custom_emoji:";
  if (trimmed.startsWith(customEmojiPrefix)) {
    const customEmojiId = trimmed.slice(customEmojiPrefix.length).trim();
    if (!customEmojiId) {
      return null;
    }
    return {
      type: "custom_emoji",
      custom_emoji_id: customEmojiId,
    };
  }

  return {
    type: "emoji",
    emoji: trimmed as ReactionTypeEmoji["emoji"],
  };
}

function getTelegramReactionSenderName(
  update: TelegramReactionUpdate,
): string | undefined {
  if (update.user) {
    return getTelegramSenderName({
      from: update.user,
    } as TelegramLikeMessage);
  }

  if (update.actor_chat?.username?.trim()) {
    return update.actor_chat.username.trim();
  }

  if (update.actor_chat?.title?.trim()) {
    return update.actor_chat.title.trim();
  }

  return undefined;
}

function getTelegramReactionSenderId(
  update: TelegramReactionUpdate,
): string | null {
  if (update.user?.id !== undefined) {
    return String(update.user.id);
  }
  if (update.actor_chat?.id !== undefined) {
    return String(update.actor_chat.id);
  }
  return null;
}

function getTelegramChatType(chat: { type?: string }): "direct" | "channel" {
  return chat.type === "private" ? "direct" : "channel";
}

function truncateTelegramApprovalPreview(
  text: string,
  maxLength = 900,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildTelegramApprovalPromptText(
  event: Extract<ChannelApprovalEvent, { type: "requested" }>,
): string {
  const request = event.controlRequest.request;
  const toolName = request.tool_name || "tool";
  const inputPreview = truncateTelegramApprovalPreview(
    JSON.stringify(request.input, null, 2),
  );
  return [
    `Permission request`,
    "",
    `Allow the agent to run ${toolName}?`,
    "",
    "Input:",
    inputPreview,
  ].join("\n");
}

function buildTelegramApprovalResolvedText(
  event: Extract<ChannelApprovalEvent, { type: "resolved" }>,
): string {
  if ("decision" in event.response) {
    return event.response.decision.behavior === "allow"
      ? "Approved."
      : `Denied: ${event.response.decision.message}`;
  }
  return event.response.error
    ? `Approval is no longer available: ${event.response.error}`
    : "Approval is no longer available.";
}

export function createTelegramAdapter(
  config: TelegramChannelAccount,
): ChannelAdapter {
  let bot: TelegramBot | null = null;
  let botModule: GrammYModule | null = null;
  let running = false;
  const bufferedMediaGroups = new Map<string, BufferedMediaGroup>();
  const approvalPromptByRequestId = new Map<
    string,
    TelegramApprovalPromptState
  >();
  const approvalCallbackByToken = new Map<
    string,
    TelegramApprovalCallbackPayload
  >();

  function createApprovalCallbackToken(
    requestId: string,
    decision: "allow" | "deny",
  ): string {
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    approvalCallbackByToken.set(token, {
      requestId,
      decision,
    });
    return `lcapp:${token}`;
  }

  function resolveApprovalCallbackPayload(
    data: string,
  ): TelegramApprovalCallbackPayload | null {
    const prefix = "lcapp:";
    if (!data.startsWith(prefix)) {
      return null;
    }
    const token = data.slice(prefix.length).trim();
    if (!token) {
      return null;
    }
    return approvalCallbackByToken.get(token) ?? null;
  }

  function clearApprovalCallbackTokens(requestId: string): void {
    for (const [token, payload] of approvalCallbackByToken) {
      if (payload.requestId === requestId) {
        approvalCallbackByToken.delete(token);
      }
    }
  }

  async function ensureModule(): Promise<GrammYModule> {
    if (!botModule) {
      botModule = await loadGrammyModule();
    }
    return botModule;
  }

  async function emitInboundMessages(
    telegramBot: TelegramBot,
    messages: TelegramLikeMessage[],
  ): Promise<void> {
    if (!adapter.onMessage) {
      return;
    }

    const primaryMessage =
      messages.find((message) => extractTelegramMessageText(message).trim()) ??
      messages[0];
    if (!primaryMessage?.from) {
      return;
    }

    const text = extractTelegramMessageText(primaryMessage);
    const attachments = await resolveTelegramInboundAttachments({
      accountId: config.accountId,
      token: config.token,
      bot: telegramBot,
      messages,
    });

    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const inbound: InboundChannelMessage = {
      channel: "telegram",
      accountId: config.accountId,
      chatId: String(primaryMessage.chat.id),
      senderId: String(primaryMessage.from.id),
      senderName: getTelegramSenderName(primaryMessage),
      text,
      timestamp: primaryMessage.date * 1000,
      messageId: String(primaryMessage.message_id),
      chatType: "direct",
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: messages.length === 1 ? primaryMessage : messages,
    };

    try {
      await adapter.onMessage(inbound);
    } catch (error) {
      console.error("[Telegram] Error handling inbound message:", error);
    }
  }

  function scheduleBufferedMediaGroupFlush(
    telegramBot: TelegramBot,
    mediaGroupId: string,
  ): void {
    const entry = bufferedMediaGroups.get(mediaGroupId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const buffered = bufferedMediaGroups.get(mediaGroupId);
      if (!buffered) {
        return;
      }
      bufferedMediaGroups.delete(mediaGroupId);
      void emitInboundMessages(telegramBot, buffered.messages);
    }, TELEGRAM_MEDIA_GROUP_FLUSH_MS);
  }

  async function ensureBot(): Promise<TelegramBot> {
    if (bot) {
      return bot;
    }

    const grammy = await ensureModule();
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

    instance.on("message", async (ctx) => {
      const msg = ctx.message as TelegramLikeMessage | undefined;
      if (!msg?.from) {
        return;
      }

      const mediaGroupId =
        typeof msg.media_group_id === "string" ? msg.media_group_id : null;
      if (mediaGroupId) {
        const existing = bufferedMediaGroups.get(mediaGroupId);
        if (existing) {
          existing.messages.push(msg);
        } else {
          bufferedMediaGroups.set(mediaGroupId, {
            messages: [msg],
            timer: setTimeout(() => undefined, TELEGRAM_MEDIA_GROUP_FLUSH_MS),
          });
        }
        scheduleBufferedMediaGroupFlush(instance, mediaGroupId);
        return;
      }

      await emitInboundMessages(instance, [msg]);
    });

    instance.on("message_reaction", async (ctx) => {
      if (!adapter.onMessage) {
        return;
      }

      const update = ctx.messageReaction as TelegramReactionUpdate | undefined;
      if (!update) {
        return;
      }

      const senderId = getTelegramReactionSenderId(update);
      if (!senderId) {
        return;
      }

      const oldTokens = new Set(
        update.old_reaction
          .map((reaction) => getTelegramReactionToken(reaction))
          .filter((value): value is string => typeof value === "string"),
      );
      const newTokens = new Set(
        update.new_reaction
          .map((reaction) => getTelegramReactionToken(reaction))
          .filter((value): value is string => typeof value === "string"),
      );

      const events: Array<{ action: "added" | "removed"; emoji: string }> = [];

      for (const emoji of oldTokens) {
        if (!newTokens.has(emoji)) {
          events.push({ action: "removed", emoji });
        }
      }

      for (const emoji of newTokens) {
        if (!oldTokens.has(emoji)) {
          events.push({ action: "added", emoji });
        }
      }

      for (const event of events) {
        try {
          await adapter.onMessage({
            channel: "telegram",
            accountId: config.accountId,
            chatId: String(update.chat.id),
            senderId,
            senderName: getTelegramReactionSenderName(update),
            text: `Telegram reaction ${event.action}: ${event.emoji}`,
            timestamp: update.date * 1000,
            messageId: String(update.message_id),
            chatType: getTelegramChatType(update.chat),
            reaction: {
              action: event.action,
              emoji: event.emoji,
              targetMessageId: String(update.message_id),
            },
            raw: update,
          });
        } catch (error) {
          console.error("[Telegram] Error handling reaction update:", error);
        }
      }
    });

    instance.on("callback_query:data", async (ctx) => {
      const data =
        typeof ctx.callbackQuery?.data === "string"
          ? ctx.callbackQuery.data
          : "";
      const parsed = resolveApprovalCallbackPayload(data);
      if (!parsed) {
        return;
      }

      const promptState = approvalPromptByRequestId.get(parsed.requestId);
      if (!promptState) {
        await ctx.answerCallbackQuery({
          text: "This approval request is no longer available.",
          show_alert: true,
        });
        return;
      }

      const actorId =
        ctx.from?.id !== undefined ? String(ctx.from.id) : undefined;
      if (
        promptState.allowedSenderIds.size > 0 &&
        (!actorId || !promptState.allowedSenderIds.has(actorId))
      ) {
        await ctx.answerCallbackQuery({
          text: "Only the person who triggered this request can approve or deny it.",
          show_alert: true,
        });
        return;
      }

      if (!adapter.onApprovalResponse) {
        await ctx.answerCallbackQuery({
          text: "Approvals are unavailable right now. Try again in a moment.",
          show_alert: true,
        });
        return;
      }

      const accepted = await adapter.onApprovalResponse({
        requestId: parsed.requestId,
        decision:
          parsed.decision === "allow"
            ? {
                behavior: "allow",
                message: actorId
                  ? `Approved from Telegram by ${actorId}`
                  : "Approved from Telegram",
              }
            : {
                behavior: "deny",
                message: actorId
                  ? `Denied from Telegram by ${actorId}`
                  : "Denied from Telegram",
              },
      });

      await ctx.answerCallbackQuery({
        text: accepted
          ? parsed.decision === "allow"
            ? "Approved"
            : "Denied"
          : "This approval request is no longer available.",
        show_alert: !accepted,
      });
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
    id: `telegram:${config.accountId}`,
    channelId: "telegram",
    accountId: config.accountId,
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
            allowed_updates: ["message", "message_reaction", "callback_query"],
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
      for (const entry of bufferedMediaGroups.values()) {
        clearTimeout(entry.timer);
      }
      bufferedMediaGroups.clear();
      approvalPromptByRequestId.clear();
      approvalCallbackByToken.clear();

      if (!running || !bot) return;
      await bot.stop();
      running = false;
      console.log("[Telegram] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleApprovalEvent(event: ChannelApprovalEvent): Promise<void> {
      const telegramBot = await ensureBot();
      if (!running) {
        return;
      }

      if (event.type === "requested") {
        if (approvalPromptByRequestId.has(event.controlRequest.request_id)) {
          return;
        }

        const source = event.sources[0];
        if (!source) {
          return;
        }

        const response = await telegramBot.api.sendMessage(
          source.chatId,
          buildTelegramApprovalPromptText(event),
          {
            ...(source.messageId
              ? {
                  reply_parameters: {
                    message_id: Number(source.messageId),
                  },
                }
              : {}),
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Approve",
                    callback_data: createApprovalCallbackToken(
                      event.controlRequest.request_id,
                      "allow",
                    ),
                  },
                  {
                    text: "Deny",
                    callback_data: createApprovalCallbackToken(
                      event.controlRequest.request_id,
                      "deny",
                    ),
                  },
                ],
              ],
            },
          },
        );

        approvalPromptByRequestId.set(event.controlRequest.request_id, {
          chatId: source.chatId,
          messageId: response.message_id,
          allowedSenderIds: new Set(
            event.sources
              .map((entry) => entry.senderId)
              .filter((value): value is string => typeof value === "string"),
          ),
        });
        return;
      }

      const promptState = approvalPromptByRequestId.get(
        event.controlRequest.request_id,
      );
      if (!promptState) {
        return;
      }

      await telegramBot.api.editMessageText(
        promptState.chatId,
        promptState.messageId,
        buildTelegramApprovalResolvedText(event),
        {
          reply_markup: {
            inline_keyboard: [],
          },
        },
      );
      approvalPromptByRequestId.delete(event.controlRequest.request_id);
      clearApprovalCallbackTokens(event.controlRequest.request_id);
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      const telegramBot = await ensureBot();

      if (msg.reaction || msg.removeReaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error(
            "Telegram reactions require message_id (or reply_to_message_id) to identify the target message.",
          );
        }

        if (!msg.removeReaction) {
          const reaction = parseTelegramReactionInput(msg.reaction ?? "");
          if (!reaction) {
            throw new Error("Telegram reaction emoji cannot be empty.");
          }

          await telegramBot.api.setMessageReaction(
            msg.chatId,
            Number(targetMessageId),
            [reaction],
          );
        } else {
          await telegramBot.api.setMessageReaction(
            msg.chatId,
            Number(targetMessageId),
            [],
          );
        }

        return { messageId: targetMessageId };
      }

      if (msg.mediaPath) {
        const grammy = await ensureModule();
        const InputFile = resolveTelegramInputFileConstructor(grammy);
        const mediaPath = msg.mediaPath;
        const fileName = msg.fileName;
        const inputFile = new InputFile(mediaPath, fileName);
        const options = buildTelegramReplyOptions(msg);
        const uploadMethod = detectTelegramUploadMethod(mediaPath, fileName);

        const result = await (async () => {
          switch (uploadMethod) {
            case "photo":
              return await telegramBot.api.sendPhoto(
                msg.chatId,
                inputFile,
                options,
              );
            case "video":
              return await telegramBot.api.sendVideo(
                msg.chatId,
                inputFile,
                options,
              );
            case "audio":
              return await telegramBot.api.sendAudio(
                msg.chatId,
                inputFile,
                options,
              );
            case "voice":
              return await telegramBot.api.sendVoice(
                msg.chatId,
                inputFile,
                options,
              );
            case "animation":
              return await telegramBot.api.sendAnimation(
                msg.chatId,
                inputFile,
                options,
              );
            default:
              return await telegramBot.api.sendDocument(
                msg.chatId,
                inputFile,
                options,
              );
          }
        })();

        return { messageId: String(result.message_id) };
      }

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
