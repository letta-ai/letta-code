/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 */

import type { ReactionType, ReactionTypeEmoji } from "@grammyjs/types";
import type { Bot as GrammYBot, Context as GrammYContext } from "grammy";
import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "@/channels/inbound-debounce";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import { normalizeChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelReplyContext,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelAccount,
} from "@/channels/types";
import {
  buildTelegramDebounceKey,
  resolveTelegramInboundDebounceMs,
} from "./debounce";
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

type TelegramMentionResult = {
  isMention: boolean;
  text: string;
};

const TELEGRAM_LIFECYCLE_ERROR_TEXT_MAX = 3500;
const TELEGRAM_LIFECYCLE_ERROR_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_LIFECYCLE_ERROR_DEDUPE_MAX = 1000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTelegramMessageEntities(message: TelegramLikeMessage): Array<{
  type?: string;
  offset?: number;
  length?: number;
}> {
  return message.text !== undefined
    ? (message.entities ?? [])
    : (message.caption_entities ?? []);
}

export function detectTelegramBotMention(
  message: TelegramLikeMessage,
  botUsername: string | null | undefined,
  botDisplayName?: string | null | undefined,
  text: string = extractTelegramMessageText(message),
): TelegramMentionResult {
  const username = botUsername?.trim().replace(/^@/, "");
  const displayName = botDisplayName?.trim();
  if (!username && !displayName) {
    return { isMention: false, text };
  }

  const mention = username ? `@${username}` : null;
  const mentionRegex = mention
    ? new RegExp(`(^|\\s)${escapeRegExp(mention)}(?=$|\\s|[,.!?;:])`, "i")
    : null;
  const entityMentioned = getTelegramMessageEntities(message).some((entity) => {
    if (!mention) return false;
    if (entity.type !== "mention") return false;
    if (
      typeof entity.offset !== "number" ||
      typeof entity.length !== "number" ||
      entity.offset < 0 ||
      entity.length <= 0
    ) {
      return false;
    }
    return (
      text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
      mention.toLowerCase()
    );
  });
  const regexMentioned = mentionRegex?.test(text) ?? false;
  const leadingNameRegex = displayName
    ? new RegExp(
        `^\\s*${escapeRegExp(displayName)}(?:[:,]?\\s+|[,:]\\s*|$)`,
        "i",
      )
    : null;
  const leadingNameMentioned = leadingNameRegex?.test(text) ?? false;
  const isMention = entityMentioned || regexMentioned || leadingNameMentioned;
  if (!isMention) {
    return { isMention: false, text };
  }

  const leadingMentionRegex = mention
    ? new RegExp(`^\\s*${escapeRegExp(mention)}(?:[:,]?\\s*|$)`, "i")
    : null;
  const stripped = leadingMentionRegex
    ? text.replace(leadingMentionRegex, "")
    : text;
  return {
    isMention: true,
    text: leadingNameRegex
      ? stripped.replace(leadingNameRegex, "").trimStart()
      : stripped.trimStart(),
  };
}

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
    "replyToMessageId" | "threadId" | "parseMode" | "text" | "title"
  >,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (msg.threadId) {
    options.message_thread_id = Number(msg.threadId);
  }
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
  return !chat.type || chat.type === "private" ? "direct" : "channel";
}

function getTelegramChatLabel(
  message: TelegramLikeMessage,
): string | undefined {
  const title = message.chat.title?.trim();
  if (title) {
    return title;
  }
  const username = message.chat.username?.trim();
  if (username) {
    return username.startsWith("@") ? username : `@${username}`;
  }
  return undefined;
}

function getTelegramMessageThreadId(
  message: TelegramLikeMessage,
): string | null {
  return message.message_thread_id !== undefined
    ? String(message.message_thread_id)
    : null;
}

function getTelegramReplyContext(
  message: TelegramLikeMessage,
): ChannelReplyContext | undefined {
  const replied = message.reply_to_message;
  if (!replied) {
    return undefined;
  }

  const text = extractTelegramMessageText(replied).trim();
  const context: ChannelReplyContext = {
    messageId: String(replied.message_id),
  };
  if (replied.from?.id !== undefined) {
    context.senderId = String(replied.from.id);
  }
  const senderName = getTelegramSenderName(replied);
  if (senderName) {
    context.senderName = senderName;
  }
  if (text) {
    context.text = text;
  }
  return context;
}

function getTelegramLifecycleErrorReplyKey(
  source: ChannelTurnSource,
): string | null {
  if (source.channel !== "telegram" || !source.chatId) {
    return null;
  }
  return [
    source.chatId,
    source.threadId ?? source.messageId ?? "",
    source.conversationId,
  ].join(":");
}

function formatTelegramLifecycleErrorMessage(errorText: string): string {
  const normalized = normalizeChannelLifecycleErrorMessage(errorText);
  const truncated =
    normalized.length > TELEGRAM_LIFECYCLE_ERROR_TEXT_MAX
      ? `${normalized
          .slice(0, TELEGRAM_LIFECYCLE_ERROR_TEXT_MAX - 1)
          .trimEnd()}…`
      : normalized;
  return `Turn failed:\n${truncated}`;
}

const TELEGRAM_TYPING_REFRESH_MS = 4_000;
const TELEGRAM_TYPING_MAX_MS = 5 * 60 * 1000;

type TelegramTypingEntry = {
  sourceKeys: Set<string>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

type TelegramDebounceEntry = {
  inbound: InboundChannelMessage;
};

export function createTelegramAdapter(
  config: TelegramChannelAccount,
): ChannelAdapter {
  let bot: TelegramBot | null = null;
  let botModule: GrammYModule | null = null;
  let running = false;
  const bufferedMediaGroups = new Map<string, BufferedMediaGroup>();
  const lifecycleErrorReplies = new Map<string, number>();
  const typingByChatId = new Map<string, TelegramTypingEntry>();
  const debounceMs = resolveTelegramInboundDebounceMs(config);

  const debouncer: InboundDebouncer<TelegramDebounceEntry> =
    createInboundDebouncer<TelegramDebounceEntry>({
      debounceMs,
      buildKey: ({ inbound }) =>
        buildTelegramDebounceKey(
          { chatId: inbound.chatId, threadId: inbound.threadId },
          config.accountId,
        ),
      shouldDebounce: ({ inbound }) =>
        inbound.chatType === "channel" &&
        !inbound.attachments?.length &&
        !inbound.reaction,
      onFlush: async (entries) => {
        const last = entries[entries.length - 1];
        if (!last || !adapter.onMessage) {
          return;
        }

        const combinedText =
          entries.length === 1
            ? last.inbound.text
            : entries
                .map((entry) => {
                  const text = entry.inbound.text.trim();
                  if (!text) return null;
                  const sender =
                    entry.inbound.senderName?.trim() || entry.inbound.senderId;
                  return `${sender}: ${text}`;
                })
                .filter((line): line is string => line !== null)
                .join("\n");

        const merged: InboundChannelMessage = {
          ...last.inbound,
          text: combinedText,
          raw:
            entries.length === 1
              ? last.inbound.raw
              : entries.map((entry) => entry.inbound.raw),
        };

        try {
          await adapter.onMessage(merged);
        } catch (error) {
          console.error(
            "[Telegram] Error handling debounced inbound message:",
            error,
          );
        }
      },
      onError: (err) => {
        console.error(
          "[Telegram] Inbound debounce flush failed:",
          err instanceof Error ? err.message : err,
        );
      },
    });

  async function dispatchInbound(
    inbound: InboundChannelMessage,
  ): Promise<void> {
    await debouncer.enqueue({ inbound });
  }

  async function sendTypingAction(chatId: string): Promise<void> {
    if (!running) return;
    try {
      const telegramBot = await ensureBot();
      await telegramBot.api.sendChatAction(chatId, "typing");
    } catch (error) {
      console.warn(
        `[Telegram] Failed to send typing action for chat ${chatId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  function getTypingSourceKey(source: ChannelTurnSource): string | null {
    const chatId = getTypingChatId(source);
    if (!chatId) return null;
    return [
      source.accountId ?? "",
      chatId,
      source.threadId ?? "",
      source.messageId ?? "",
      source.agentId,
      source.conversationId,
    ].join(":");
  }

  function startTypingForSource(source: ChannelTurnSource): void {
    const chatId = getTypingChatId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!chatId || !sourceKey) return;

    const existing = typingByChatId.get(chatId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      return;
    }
    void sendTypingAction(chatId);
    const timer = setInterval(() => {
      void sendTypingAction(chatId);
    }, TELEGRAM_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => {
      clearTypingForChat(chatId);
    }, TELEGRAM_TYPING_MAX_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref?.();
    }
    if (typeof (timeout as { unref?: () => void }).unref === "function") {
      (timeout as { unref?: () => void }).unref?.();
    }
    typingByChatId.set(chatId, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout,
    });
  }

  function stopTypingForSource(source: ChannelTurnSource): void {
    const chatId = getTypingChatId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!chatId || !sourceKey) return;

    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) {
      clearTypingForChat(chatId);
    }
  }

  function clearTypingForChat(chatId: string): void {
    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChatId.delete(chatId);
  }

  function clearAllTyping(): void {
    for (const entry of typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChatId.clear();
  }

  function getTypingChatId(source: ChannelTurnSource): string | null {
    if (source.channel !== "telegram") return null;
    const chatId = source.chatId;
    if (typeof chatId !== "string" || chatId.length === 0) return null;
    return chatId;
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

    const mention = detectTelegramBotMention(
      primaryMessage,
      telegramBot.botInfo?.username,
      telegramBot.botInfo?.first_name,
    );
    const text = mention.text;
    const attachments = await resolveTelegramInboundAttachments({
      accountId: config.accountId,
      token: config.token,
      bot: telegramBot,
      messages,
      transcribeVoice: config.transcribeVoice,
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
      isMention: mention.isMention,
      timestamp: primaryMessage.date * 1000,
      messageId: String(primaryMessage.message_id),
      chatType: getTelegramChatType(primaryMessage.chat),
      attachments: attachments.length > 0 ? attachments : undefined,
      replyContext: getTelegramReplyContext(primaryMessage),
      raw: messages.length === 1 ? primaryMessage : messages,
    };
    const chatLabel = getTelegramChatLabel(primaryMessage);
    if (chatLabel) {
      inbound.chatLabel = chatLabel;
    }
    const threadId = getTelegramMessageThreadId(primaryMessage);
    if (threadId) {
      inbound.threadId = threadId;
    }

    await dispatchInbound(inbound);
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
            chatLabel:
              update.chat.title?.trim() ||
              (update.chat.username?.trim()
                ? `@${update.chat.username.trim()}`
                : undefined),
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

  function rememberLifecycleErrorReply(key: string): boolean {
    const now = Date.now();
    for (const [existingKey, expiresAt] of lifecycleErrorReplies) {
      if (expiresAt <= now) {
        lifecycleErrorReplies.delete(existingKey);
      }
    }
    if (lifecycleErrorReplies.has(key)) {
      return false;
    }
    if (lifecycleErrorReplies.size >= TELEGRAM_LIFECYCLE_ERROR_DEDUPE_MAX) {
      const [oldestKey] = lifecycleErrorReplies.keys();
      if (oldestKey) {
        lifecycleErrorReplies.delete(oldestKey);
      }
    }
    lifecycleErrorReplies.set(
      key,
      now + TELEGRAM_LIFECYCLE_ERROR_DEDUPE_TTL_MS,
    );
    return true;
  }

  async function sendLifecycleErrorReply(
    source: ChannelTurnSource,
    errorText: string,
  ): Promise<void> {
    const key = getTelegramLifecycleErrorReplyKey(source);
    if (!key || !rememberLifecycleErrorReply(key)) {
      return;
    }

    const telegramBot = await ensureBot();
    const replyToMessageId = source.threadId ?? source.messageId;
    let reply_parameters: { message_id: number } | undefined;
    if (replyToMessageId) {
      const numericReplyToMessageId = Number(replyToMessageId);
      if (Number.isFinite(numericReplyToMessageId)) {
        reply_parameters = { message_id: numericReplyToMessageId };
      }
    }

    await telegramBot.api.sendMessage(
      source.chatId,
      formatTelegramLifecycleErrorMessage(errorText),
      {
        ...(source.threadId
          ? { message_thread_id: Number(source.threadId) }
          : {}),
        ...(reply_parameters ? { reply_parameters } : {}),
      },
    );
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
            allowed_updates: ["message", "message_reaction"],
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
      lifecycleErrorReplies.clear();
      clearAllTyping();

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

        clearTypingForChat(msg.chatId);
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

        clearTypingForChat(msg.chatId);
        return { messageId: String(result.message_id) };
      }

      const opts: Record<string, unknown> = {};
      if (msg.threadId) {
        opts.message_thread_id = Number(msg.threadId);
      }
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
      clearTypingForChat(msg.chatId);
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

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;

      if (event.type === "queued") {
        return;
      }

      if (event.type === "processing") {
        for (const source of event.sources) {
          startTypingForSource(source);
        }
        return;
      }

      for (const source of event.sources) {
        stopTypingForSource(source);
      }

      if (event.outcome !== "error" || !event.error?.trim()) {
        return;
      }

      const uniqueSources = new Map<string, ChannelTurnSource>();
      for (const source of event.sources) {
        const key = getTelegramLifecycleErrorReplyKey(source);
        if (!key || uniqueSources.has(key)) {
          continue;
        }
        uniqueSources.set(key, source);
      }

      await Promise.all(
        Array.from(uniqueSources.values()).map(async (source) => {
          try {
            await sendLifecycleErrorReply(source, event.error ?? "Turn failed");
          } catch (error) {
            console.warn(
              `[Telegram] Failed to send lifecycle error reply for ${source.chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    },

    async handleControlRequestEvent(
      event: ChannelControlRequestEvent,
    ): Promise<void> {
      const telegramBot = await ensureBot();
      const reply_parameters =
        event.source.messageId || event.source.threadId
          ? {
              message_id: Number(
                event.source.threadId ?? event.source.messageId,
              ),
            }
          : undefined;
      await telegramBot.api.sendMessage(
        event.source.chatId,
        formatChannelControlRequestPrompt(event),
        {
          ...(event.source.threadId
            ? { message_thread_id: Number(event.source.threadId) }
            : {}),
          ...(reply_parameters ? { reply_parameters } : {}),
        },
      );
      clearTypingForChat(event.source.chatId);
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
