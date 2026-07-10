/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 */

import { randomUUID } from "node:crypto";
import type { Context as GrammYContext } from "grammy";
import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "@/channels/inbound-debounce";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import {
  buildChannelLifecycleErrorReport,
  submitChannelLifecycleErrorReport,
} from "@/channels/lifecycle-error-report";
import type {
  ChannelAdapter,
  ChannelAdapterStartOptions,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  OutboundChannelRichMessageDraft,
  TelegramChannelAccount,
} from "@/channels/types";
import {
  buildTelegramDebounceKey,
  resolveTelegramInboundDebounceMs,
} from "./debounce";
import type {
  BufferedMediaGroup,
  GrammYModule,
  TelegramBot,
  TelegramCallbackContext,
  TelegramDebounceEntry,
  TelegramLifecycleErrorReportEntry,
  TelegramReactionUpdate,
  TelegramRichMessageRawApi,
} from "./internal-types";
import {
  detectTelegramUploadMethod,
  extractTelegramMessageText,
  getTelegramSenderName,
  resolveTelegramInboundAttachments,
  TELEGRAM_MEDIA_GROUP_FLUSH_MS,
  type TelegramLikeMessage,
} from "./media";
import { loadGrammyModule } from "./runtime";
import {
  DEFAULT_TELEGRAM_INIT_TIMEOUT_MS,
  DEFAULT_TELEGRAM_START_TIMEOUT_MS,
  getStartupTimeoutMs,
  logTelegramStartup,
  stopTelegramBotQuietly,
  withStartupTimeout,
} from "./startup-helpers";
import { createTelegramTypingController } from "./typing-controller";
import {
  buildTelegramReplyOptions,
  buildTelegramRichMessageDraftPayload,
  buildTelegramRichMessagePayload,
  detectTelegramBotMention,
  formatTelegramLifecycleErrorMessage,
  getTelegramChatLabel,
  getTelegramChatType,
  getTelegramErrorText,
  getTelegramLifecycleErrorReplyKey,
  getTelegramMessageThreadId,
  getTelegramReactionSenderId,
  getTelegramReactionSenderName,
  getTelegramReactionToken,
  getTelegramReplyContext,
  parseTelegramReactionInput,
  resolveTelegramBotConstructor,
  resolveTelegramInputFileConstructor,
  resolveTelegramOutboundThreadId,
  shouldFallbackTelegramRichMessage,
  TELEGRAM_LIFECYCLE_ERROR_DEDUPE_MAX,
  TELEGRAM_LIFECYCLE_ERROR_DEDUPE_TTL_MS,
  TELEGRAM_LIFECYCLE_ERROR_REPORT_MAX,
  TELEGRAM_LIFECYCLE_ERROR_REPORT_TTL_MS,
  TELEGRAM_REPORT_CALLBACK_PREFIX,
} from "./utils";

export function createTelegramAdapter(
  config: TelegramChannelAccount,
): ChannelAdapter {
  let bot: TelegramBot | null = null;
  let botModule: GrammYModule | null = null;
  let running = false;
  const bufferedMediaGroups = new Map<string, BufferedMediaGroup>();
  const lifecycleErrorReplies = new Map<string, number>();
  const lifecycleErrorReports = new Map<
    string,
    TelegramLifecycleErrorReportEntry
  >();
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

  const typing = createTelegramTypingController({ sendTypingAction });

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

  async function ensureBot(
    options?: ChannelAdapterStartOptions,
  ): Promise<TelegramBot> {
    if (bot) {
      return bot;
    }

    logTelegramStartup(options, "loading grammY runtime");
    const grammy = await ensureModule();
    logTelegramStartup(options, "grammY runtime loaded");
    const Bot = resolveTelegramBotConstructor(grammy);
    logTelegramStartup(
      options,
      `constructing bot for account ${config.accountId}`,
    );
    const instance = new Bot(config.token);

    instance.catch((error) => {
      const updateId = error.ctx?.update?.update_id;
      const prefix =
        updateId === undefined
          ? "[Telegram] Unhandled bot error:"
          : `[Telegram] Unhandled bot error for update ${updateId}:`;
      console.error(prefix, error.error);
    });

    instance.on("callback_query", async (ctx) => {
      await handleLifecycleErrorReportCallback(ctx);
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

    logTelegramStartup(
      options,
      `handlers registered for account ${config.accountId}`,
    );
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

  function pruneLifecycleErrorReports(now: number = Date.now()): void {
    for (const [token, entry] of lifecycleErrorReports) {
      if (entry.expiresAt <= now) {
        lifecycleErrorReports.delete(token);
      }
    }

    if (lifecycleErrorReports.size <= TELEGRAM_LIFECYCLE_ERROR_REPORT_MAX) {
      return;
    }

    const overflowCount =
      lifecycleErrorReports.size - TELEGRAM_LIFECYCLE_ERROR_REPORT_MAX;
    const oldestEntries = Array.from(lifecycleErrorReports.entries()).sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        lifecycleErrorReports.delete(entry[0]);
      }
    }
  }

  function rememberLifecycleErrorReport(
    source: ChannelTurnSource,
    errorText: string,
    runId?: string | null,
  ): string {
    pruneLifecycleErrorReports();
    const token = randomUUID();
    lifecycleErrorReports.set(token, {
      expiresAt: Date.now() + TELEGRAM_LIFECYCLE_ERROR_REPORT_TTL_MS,
      report: buildChannelLifecycleErrorReport(source, errorText, { runId }),
      submitted: false,
    });
    return `${TELEGRAM_REPORT_CALLBACK_PREFIX}${token}`;
  }

  async function answerLifecycleErrorReportCallback(
    ctx: TelegramCallbackContext,
    text: string,
    showAlert = false,
  ): Promise<void> {
    if (typeof ctx.answerCallbackQuery !== "function") {
      return;
    }
    await ctx.answerCallbackQuery({ text, show_alert: showAlert });
  }

  async function handleLifecycleErrorReportCallback(
    ctx: GrammYContext,
  ): Promise<void> {
    const callbackCtx = ctx as TelegramCallbackContext;
    const data = callbackCtx.callbackQuery?.data?.trim();
    if (!data?.startsWith(TELEGRAM_REPORT_CALLBACK_PREFIX)) {
      return;
    }

    const token = data.slice(TELEGRAM_REPORT_CALLBACK_PREFIX.length);
    const entry = lifecycleErrorReports.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      lifecycleErrorReports.delete(token);
      await answerLifecycleErrorReportCallback(
        callbackCtx,
        "This error report button expired.",
        true,
      );
      return;
    }

    if (entry.submitted) {
      await answerLifecycleErrorReportCallback(
        callbackCtx,
        "Error report already sent.",
      );
      return;
    }

    entry.submitted = true;
    try {
      await submitChannelLifecycleErrorReport(entry.report);
      await answerLifecycleErrorReportCallback(
        callbackCtx,
        "Error report sent. Thanks.",
      );
    } catch (error) {
      entry.submitted = false;
      console.warn(
        "[Telegram] Failed to submit lifecycle error report:",
        error instanceof Error ? error.message : error,
      );
      await answerLifecycleErrorReportCallback(
        callbackCtx,
        "Could not send the error report. Please try again later.",
        true,
      );
    }
  }

  async function sendLifecycleErrorReply(
    source: ChannelTurnSource,
    errorText: string,
    runId?: string | null,
  ): Promise<void> {
    const key = getTelegramLifecycleErrorReplyKey(source);
    if (!key || !rememberLifecycleErrorReply(key)) {
      return;
    }

    const telegramBot = await ensureBot();
    const threadId = resolveTelegramOutboundThreadId(source);
    const replyToMessageId = threadId ?? source.messageId;
    let reply_parameters: { message_id: number } | undefined;
    if (replyToMessageId) {
      const numericReplyToMessageId = Number(replyToMessageId);
      if (Number.isFinite(numericReplyToMessageId)) {
        reply_parameters = { message_id: numericReplyToMessageId };
      }
    }

    const options: Record<string, unknown> = {
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      ...(reply_parameters ? { reply_parameters } : {}),
    };
    options.reply_markup = {
      inline_keyboard: [
        [
          {
            text: "Report error",
            callback_data: rememberLifecycleErrorReport(
              source,
              errorText,
              runId,
            ),
          },
        ],
      ],
    };

    await telegramBot.api.sendMessage(
      source.chatId,
      formatTelegramLifecycleErrorMessage(errorText, runId),
      options,
    );
  }

  const adapter: ChannelAdapter = {
    id: `telegram:${config.accountId}`,
    channelId: "telegram",
    accountId: config.accountId,
    name: "Telegram",

    async start(options?: ChannelAdapterStartOptions): Promise<void> {
      if (running) return;
      logTelegramStartup(
        options,
        `start requested for account ${config.accountId}`,
      );
      const telegramBot = await ensureBot(options);

      logTelegramStartup(options, `init start for account ${config.accountId}`);
      try {
        await withStartupTimeout(
          telegramBot.init(),
          "Telegram bot init",
          getStartupTimeoutMs(
            "LETTA_TELEGRAM_INIT_TIMEOUT_MS",
            DEFAULT_TELEGRAM_INIT_TIMEOUT_MS,
          ),
        );
      } catch (error) {
        await stopTelegramBotQuietly(telegramBot, options);
        throw error;
      }
      const info = telegramBot.botInfo;
      console.log(
        `[Telegram] Bot started as @${info.username} (dm_policy: ${config.dmPolicy})`,
      );
      logTelegramStartup(
        options,
        `polling start for account ${config.accountId}`,
      );

      try {
        await withStartupTimeout(
          new Promise<void>((resolve, reject) => {
            let started = false;

            void telegramBot
              .start({
                allowed_updates: [
                  "message",
                  "message_reaction",
                  "callback_query",
                ],
                onStart: () => {
                  running = true;
                  started = true;
                  logTelegramStartup(
                    options,
                    `polling ready for account ${config.accountId}`,
                  );
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
          }),
          "Telegram bot polling start",
          getStartupTimeoutMs(
            "LETTA_TELEGRAM_START_TIMEOUT_MS",
            DEFAULT_TELEGRAM_START_TIMEOUT_MS,
          ),
        );
      } catch (error) {
        running = false;
        await stopTelegramBotQuietly(telegramBot, options);
        throw error;
      }
    },

    async stop(): Promise<void> {
      for (const entry of bufferedMediaGroups.values()) {
        clearTimeout(entry.timer);
      }
      bufferedMediaGroups.clear();
      lifecycleErrorReplies.clear();
      lifecycleErrorReports.clear();
      typing.clearAll();

      if (!running || !bot) return;
      await bot.stop();
      running = false;
      console.log("[Telegram] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async sendRichMessageDraft(
      draft: OutboundChannelRichMessageDraft,
    ): Promise<void> {
      const telegramBot = await ensureBot();
      const raw = telegramBot.api.raw as unknown as TelegramRichMessageRawApi;
      await raw.sendRichMessageDraft(
        buildTelegramRichMessageDraftPayload(draft),
      );
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

        typing.clearChat(msg.chatId);
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

        typing.clearChat(msg.chatId);
        return { messageId: String(result.message_id) };
      }

      if (msg.richMessage) {
        const raw = telegramBot.api.raw as unknown as TelegramRichMessageRawApi;
        try {
          const result = await raw.sendRichMessage(
            buildTelegramRichMessagePayload(msg),
          );
          typing.clearChat(msg.chatId);
          return { messageId: String(result.message_id) };
        } catch (error) {
          if (!shouldFallbackTelegramRichMessage(error)) {
            throw error;
          }
          console.warn(
            "[Telegram] sendRichMessage failed; falling back to sendMessage:",
            getTelegramErrorText(error),
          );
        }
      }

      const opts: Record<string, unknown> = {};
      const threadId = resolveTelegramOutboundThreadId(msg);
      if (threadId) {
        opts.message_thread_id = Number(threadId);
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
      typing.clearChat(msg.chatId);
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
          typing.start(source);
        }
        return;
      }

      for (const source of event.sources) {
        typing.stop(source);
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
            await sendLifecycleErrorReply(
              source,
              event.error ?? "Turn failed",
              event.runId,
            );
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
      const threadId = resolveTelegramOutboundThreadId(event.source);
      const replyToMessageId = threadId ?? event.source.messageId;
      const reply_parameters = replyToMessageId
        ? { message_id: Number(replyToMessageId) }
        : undefined;
      await telegramBot.api.sendMessage(
        event.source.chatId,
        formatChannelControlRequestPrompt(event),
        {
          ...(threadId ? { message_thread_id: Number(threadId) } : {}),
          ...(reply_parameters ? { reply_parameters } : {}),
        },
      );
      typing.clearChat(event.source.chatId);
    },

    onMessage: undefined,
  };

  return adapter;
}

/**
 * Validate a Telegram bot token by calling getMe().
 * Returns the bot username on success, throws on failure.
 */
