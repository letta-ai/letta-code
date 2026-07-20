import { basename } from "node:path";
import type {
  ChannelAdapter,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  DiscordChannelAccount,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "@/channels/types";
import {
  hasExplicitDiscordUserMention,
  shouldAcceptDiscordInboundBotMessage,
} from "./bot-policy";
import {
  isDiscordGuildChannelAllowed,
  resolveDiscordChannelMode,
} from "./channel-gating";
import type {
  DiscordAttachmentLike,
  DiscordClient,
  DiscordMessage,
  DiscordReactionLike,
  DiscordUserLike,
} from "./internal-types";
import {
  resolveDiscordInboundAttachments,
  resolveDiscordThreadHistory,
  resolveDiscordThreadStarter,
} from "./media";
import { type DiscordRuntimeModuleLike, loadDiscordModule } from "./runtime";
import {
  buildDiscordIngressMessageKey,
  buildDiscordReplyOptions,
  formatDiscordLifecycleErrorMessage,
  hasDiscordMessageFetcher,
  isDiscordSendableChannel,
  isDiscordTypingChannel,
  isNonEmptyString,
  normalizeDiscordMentionText,
  notifyDiscordDeliveryError,
  resolveDiscordChatType,
  resolveDiscordReactionEmoji,
  shouldAutoThreadOnDiscordMention,
  splitMessageText,
} from "./utils";

const DISCORD_SPLIT_THRESHOLD = 1900;
const INGRESS_DEDUPE_TTL_MS = 60_000;
const INGRESS_DEDUPE_MAX = 2_000;
const LIFECYCLE_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LIFECYCLE_STATE_MAX = 2_000;
const INITIAL_THREAD_HISTORY_LIMIT = 20;
const DISCORD_TYPING_REFRESH_MS = 8_000;
const DISCORD_TYPING_MAX_MS = 5 * 60 * 1000;

type LifecycleState = "queued" | "completed" | "error" | "cancelled";

type DiscordTypingEntry = {
  sourceKeys: Set<string>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

export function createDiscordAdapter(
  config: DiscordChannelAccount,
): ChannelAdapter {
  let client: DiscordClient | null = null;
  let running = false;
  let botUserId: string | null = null;
  const seenIngressMessageKeys = new Map<string, number>();
  const lifecycleStateByMessageKey = new Map<
    string,
    { state: LifecycleState; updatedAt: number }
  >();
  const lifecycleOperationByMessageKey = new Map<string, Promise<void>>();
  const lifecycleErrorReplyKeys = new Map<string, number>();
  const typingByChannelId = new Map<string, DiscordTypingEntry>();

  function pruneSeenIngressMessageKeys(now: number = Date.now()): void {
    for (const [key, expiresAt] of seenIngressMessageKeys) {
      if (expiresAt <= now) {
        seenIngressMessageKeys.delete(key);
      }
    }
    if (seenIngressMessageKeys.size <= INGRESS_DEDUPE_MAX) {
      return;
    }
    const oldestEntries = Array.from(seenIngressMessageKeys.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    const overflowCount = seenIngressMessageKeys.size - INGRESS_DEDUPE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        seenIngressMessageKeys.delete(entry[0]);
      }
    }
  }

  function markIngressMessageSeen(messageId: string | undefined): boolean {
    const key = buildDiscordIngressMessageKey(config.accountId, messageId);
    if (!key) return false;
    const now = Date.now();
    pruneSeenIngressMessageKeys(now);
    if (seenIngressMessageKeys.has(key)) return true;
    seenIngressMessageKeys.set(key, now + INGRESS_DEDUPE_TTL_MS);
    return false;
  }

  function getLifecycleMessageKey(source: ChannelTurnSource): string | null {
    if (
      source.channel !== "discord" ||
      !isNonEmptyString(source.chatId) ||
      !isNonEmptyString(source.messageId)
    ) {
      return null;
    }
    return `${source.chatId}:${source.messageId}`;
  }

  function getLifecycleReplyKey(source: ChannelTurnSource): string | null {
    if (source.channel !== "discord" || !isNonEmptyString(source.chatId)) {
      return null;
    }
    return [
      source.chatId,
      source.threadId ?? source.messageId ?? "",
      source.conversationId,
    ].join(":");
  }

  function getTypingChannelId(source: ChannelTurnSource): string | null {
    if (source.channel !== "discord") return null;
    const channelId = source.threadId ?? source.chatId;
    return isNonEmptyString(channelId) ? channelId : null;
  }

  function getTypingSourceKey(source: ChannelTurnSource): string | null {
    const channelId = getTypingChannelId(source);
    if (!channelId) return null;
    return [
      source.accountId ?? "",
      channelId,
      source.messageId ?? "",
      source.agentId,
      source.conversationId,
    ].join(":");
  }

  function pruneLifecycleState(now: number = Date.now()): void {
    for (const [key, entry] of lifecycleStateByMessageKey) {
      if (entry.updatedAt + LIFECYCLE_STATE_TTL_MS <= now) {
        lifecycleStateByMessageKey.delete(key);
      }
    }
    for (const [key, updatedAt] of lifecycleErrorReplyKeys) {
      if (updatedAt + LIFECYCLE_STATE_TTL_MS <= now) {
        lifecycleErrorReplyKeys.delete(key);
      }
    }
    if (lifecycleStateByMessageKey.size <= LIFECYCLE_STATE_MAX) {
      return;
    }
    const oldestEntries = Array.from(lifecycleStateByMessageKey.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const overflowCount = lifecycleStateByMessageKey.size - LIFECYCLE_STATE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        lifecycleStateByMessageKey.delete(entry[0]);
      }
    }
  }

  function rememberLifecycleErrorReply(key: string): boolean {
    pruneLifecycleState();
    if (lifecycleErrorReplyKeys.has(key)) {
      return false;
    }
    if (lifecycleErrorReplyKeys.size >= LIFECYCLE_STATE_MAX) {
      const [oldestKey] = lifecycleErrorReplyKeys.keys();
      if (oldestKey) {
        lifecycleErrorReplyKeys.delete(oldestKey);
      }
    }
    lifecycleErrorReplyKeys.set(key, Date.now());
    return true;
  }

  async function sendLifecycleReaction(
    source: ChannelTurnSource,
    emoji: string,
    remove = false,
  ): Promise<void> {
    if (!client || !isNonEmptyString(source.messageId)) return;
    try {
      const channel = await client.channels.fetch(source.chatId);
      if (!hasDiscordMessageFetcher(channel)) return;
      const message = await channel.messages.fetch(source.messageId);
      const resolvedEmoji = resolveDiscordReactionEmoji(emoji);
      if (remove) {
        const resolved =
          "resolve" in message.reactions &&
          typeof message.reactions.resolve === "function"
            ? message.reactions.resolve(resolvedEmoji)
            : null;
        if (resolved && botUserId) {
          await resolved.users.remove(botUserId);
        }
        return;
      }
      await message.react(resolvedEmoji);
    } catch (error) {
      console.warn(
        `[Discord] Failed to ${remove ? "remove" : "add"} lifecycle reaction:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function sendLifecycleErrorReply(
    source: ChannelTurnSource,
    errorText: string,
    runId?: string | null,
  ): Promise<void> {
    if (!client) return;
    const key = getLifecycleReplyKey(source);
    if (!key || !rememberLifecycleErrorReply(key)) {
      return;
    }

    const targetChannelId = source.threadId ?? source.chatId;
    const channel = await client.channels.fetch(targetChannelId);
    if (!isDiscordSendableChannel(channel)) {
      return;
    }
    const reply = buildDiscordReplyOptions(source.messageId, targetChannelId);
    await channel.send({
      allowedMentions: { parse: [] },
      content: formatDiscordLifecycleErrorMessage(errorText, runId),
      ...(reply ?? {}),
    });
  }

  async function sendTypingAction(channelId: string): Promise<boolean> {
    if (!running || !client) return false;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!isDiscordTypingChannel(channel)) return false;
      await channel.sendTyping();
      return true;
    } catch (error) {
      console.warn(
        `[Discord] Failed to send typing indicator for ${channelId}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async function startTypingForSource(
    source: ChannelTurnSource,
  ): Promise<void> {
    const channelId = getTypingChannelId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!channelId || !sourceKey) return;

    const existing = typingByChannelId.get(channelId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      return;
    }

    if (!(await sendTypingAction(channelId))) {
      return;
    }

    const timer = setInterval(() => {
      void sendTypingAction(channelId).then((ok) => {
        if (!ok) {
          clearTypingForChannel(channelId);
        }
      });
    }, DISCORD_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => {
      clearTypingForChannel(channelId);
    }, DISCORD_TYPING_MAX_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref?: () => void }).unref?.();
    }
    if (typeof (timeout as { unref?: () => void }).unref === "function") {
      (timeout as { unref?: () => void }).unref?.();
    }
    typingByChannelId.set(channelId, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout,
    });
  }

  function stopTypingForSource(source: ChannelTurnSource): void {
    const channelId = getTypingChannelId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!channelId || !sourceKey) return;

    const entry = typingByChannelId.get(channelId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) {
      clearTypingForChannel(channelId);
    }
  }

  function clearTypingForChannel(channelId: string): void {
    const entry = typingByChannelId.get(channelId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChannelId.delete(channelId);
  }

  function clearAllTyping(): void {
    for (const entry of typingByChannelId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChannelId.clear();
  }

  function scheduleLifecycleTransition(
    source: ChannelTurnSource,
    nextState: LifecycleState,
  ): Promise<void> | null {
    const key = getLifecycleMessageKey(source);
    if (!key) return null;
    const previous =
      lifecycleOperationByMessageKey.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        pruneLifecycleState();
        const currentState = lifecycleStateByMessageKey.get(key)?.state;
        if (currentState === nextState) {
          lifecycleStateByMessageKey.set(key, {
            state: nextState,
            updatedAt: Date.now(),
          });
          return;
        }
        if (nextState === "queued") {
          if (!currentState) {
            await sendLifecycleReaction(source, "eyes");
            lifecycleStateByMessageKey.set(key, {
              state: nextState,
              updatedAt: Date.now(),
            });
          }
          return;
        }
        if (currentState === "queued") {
          try {
            await sendLifecycleReaction(source, "eyes", true);
          } catch {}
        }
        await sendLifecycleReaction(
          source,
          nextState === "completed" ? "white_check_mark" : "x",
        );
        lifecycleStateByMessageKey.set(key, {
          state: nextState,
          updatedAt: Date.now(),
        });
      })
      .catch((error) => {
        console.warn(
          `[Discord] Failed to update lifecycle reaction for ${key}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (lifecycleOperationByMessageKey.get(key) === operation) {
          lifecycleOperationByMessageKey.delete(key);
        }
      });
    lifecycleOperationByMessageKey.set(key, operation);
    return operation;
  }

  function resolveDisplayName(message: DiscordMessage): string {
    return (
      (message.member?.displayName as string | undefined) ??
      message.author.globalName ??
      message.author.username ??
      message.author.id
    );
  }

  function hasBotMention(message: DiscordMessage): boolean {
    if (!client?.user) return false;
    return message.mentions.has(client.user);
  }

  function isThreadMessage(message: DiscordMessage): boolean {
    const ch = message.channel as { isThread?: () => boolean };
    return typeof ch.isThread === "function" && ch.isThread();
  }

  async function createThreadForMention(
    message: DiscordMessage,
    seedText: string,
  ): Promise<{ id: string; name?: string } | null> {
    const normalized = seedText.replace(/<@!?\d+>/g, "").trim();
    const firstLine = normalized.split("\n")[0]?.trim();
    const threadName = (
      firstLine || `${message.author.username} question`
    ).slice(0, 100);
    try {
      const thread = await message.startThread({
        name: threadName,
        reason: "letta-code discord mention trigger",
      });
      return { id: thread.id, name: thread.name ?? undefined };
    } catch (error) {
      console.warn(
        "[Discord] Failed to create thread for mention:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  async function collectAttachments(
    rawAttachments: Map<string, DiscordAttachmentLike>,
    chatId: string,
  ): Promise<InboundChannelMessage["attachments"]> {
    const list = Array.from(rawAttachments.values());
    if (list.length === 0) return [];
    return resolveDiscordInboundAttachments({
      accountId: config.accountId,
      rawAttachments: list.map((a) => ({
        id: a.id,
        name: a.name ?? null,
        contentType: a.contentType ?? null,
        size: a.size ?? 0,
        url: a.url,
      })),
      chatId,
    });
  }

  const adapter: ChannelAdapter = {
    id: `discord:${config.accountId}`,
    channelId: "discord",
    accountId: config.accountId,
    name: "Discord",

    async start(): Promise<void> {
      if (running) return;

      const discord: DiscordRuntimeModuleLike = await loadDiscordModule();
      const GatewayIntentBits = discord.GatewayIntentBits;
      const Partials = discord.Partials;

      client = new discord.Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
        ],
        partials: [
          Partials.Channel,
          Partials.Message,
          Partials.Reaction,
          Partials.User,
        ],
      }) as DiscordClient;

      client.once("ready", () => {
        botUserId = client?.user?.id ?? null;
        const tag = client?.user?.tag ?? "(unknown)";
        console.log(
          `[Discord] Bot logged in as ${tag} (dm_policy: ${config.dmPolicy})`,
        );
        running = true;
      });

      client.on("messageCreate", async (message: DiscordMessage) => {
        if (!adapter.onMessage) return;

        const content = (message.content ?? "").trim();
        const userId = message.author.id;
        if (!userId) return;

        const effectiveBotUserId = botUserId ?? client?.user?.id ?? null;
        const chatType = resolveDiscordChatType(message.guildId);
        const isThread = isThreadMessage(message);
        const hasParsedBotMention = hasBotMention(message);
        const wasMentioned = chatType === "channel" && hasParsedBotMention;
        if (
          !shouldAcceptDiscordInboundBotMessage({
            message,
            allowBots: config.allowBots,
            botUserId: effectiveBotUserId,
            wasExplicitlyMentioned:
              hasParsedBotMention &&
              hasExplicitDiscordUserMention(message, effectiveBotUserId),
          })
        ) {
          return;
        }

        // ── DM handling ──────────────────────────────────────────
        if (chatType === "direct") {
          if (markIngressMessageSeen(message.id)) return;

          const attachments = await collectAttachments(
            message.attachments,
            message.channelId,
          );
          if (!content && (!attachments || attachments.length === 0)) return;

          const inbound: InboundChannelMessage = {
            channel: "discord",
            accountId: config.accountId,
            chatId: message.channelId,
            senderId: userId,
            senderName: resolveDisplayName(message),
            text: content,
            timestamp: message.createdTimestamp,
            messageId: message.id,
            threadId: null,
            chatType: "direct",
            isMention: false,
            attachments,
            raw: message,
          };

          try {
            await adapter.onMessage(inbound);
          } catch (error) {
            console.error("[Discord] Error handling DM:", error);
            if (!message.author.bot) {
              await notifyDiscordDeliveryError(message, error);
            }
          }
          return;
        }

        // ── Guild handling ────────────────────────────────────────
        // Outside a thread:
        //   - "open" channels process every non-bot message
        //   - "mention-only" channels process @mentions only
        // Inside a thread: surface messages and let the registry decide whether
        // the thread is already routed, or whether a new mention is required.
        const parentChannelId =
          (message.channel as { parentId?: string | null }).parentId ?? null;
        const channelMode = resolveDiscordChannelMode(
          message.channelId,
          parentChannelId,
          isThread,
          config.allowedChannels,
        );
        const isOpenChannel = channelMode === "open";
        if (!isThread && !wasMentioned && !isOpenChannel) return;

        // Channel allowlist: when configured, only process guild messages whose
        // channel ID (or parent channel ID for thread messages) is allowed.
        if (
          !isDiscordGuildChannelAllowed({
            channelId: message.channelId,
            parentChannelId,
            isThread,
            allowedChannels: config.allowedChannels,
          })
        )
          return;

        if (markIngressMessageSeen(message.id)) return;

        let effectiveChatId = message.channelId;
        let effectiveThreadId: string | null = isThread
          ? message.channelId
          : null;

        // If mentioned outside a thread, create one — but only when the
        // account/channel is configured to auto-thread on mention. When
        // auto-threading is disabled, the mention routes to the channel
        // itself (effectiveChatId stays as message.channelId and
        // effectiveThreadId stays null) instead of spawning a new thread.
        if (!isThread && wasMentioned) {
          if (shouldAutoThreadOnDiscordMention(config, message.channelId)) {
            const createdThread = await createThreadForMention(
              message,
              content,
            );
            if (!createdThread) return;
            effectiveChatId = createdThread.id;
            effectiveThreadId = createdThread.id;
          }
        }

        const attachments = await collectAttachments(
          message.attachments,
          effectiveChatId,
        );
        const normalizedText = wasMentioned
          ? normalizeDiscordMentionText(content, botUserId)
          : content;
        if (!normalizedText && (!attachments || attachments.length === 0))
          return;

        const inbound: InboundChannelMessage = {
          channel: "discord",
          accountId: config.accountId,
          chatId: effectiveChatId,
          senderId: userId,
          senderName: resolveDisplayName(message),
          chatLabel:
            "name" in message.channel
              ? (message.channel.name ?? undefined)
              : undefined,
          text: normalizedText,
          timestamp: message.createdTimestamp,
          messageId: message.id,
          threadId: effectiveThreadId,
          parentChannelId: isThread
            ? (parentChannelId ?? undefined)
            : message.channelId,
          chatType: "channel",
          isMention: wasMentioned,
          isOpenChannel,
          attachments,
          raw: message,
        };

        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error("[Discord] Error handling guild message:", error);
          if (!message.author.bot) {
            await notifyDiscordDeliveryError(message, error);
          }
        }
      });

      // ── Reaction events ──────────────────────────────────────
      const handleReactionEvent = async (
        reaction: DiscordReactionLike,
        user: DiscordUserLike,
        action: "added" | "removed",
      ) => {
        if (!adapter.onMessage) return;
        // Ignore bot reactions
        if (user.bot) return;
        if (user.id === botUserId) return;

        try {
          if (reaction.partial) await reaction.fetch();
          if (reaction.message.partial) await reaction.message.fetch?.();
        } catch {
          return;
        }

        const msg = reaction.message;
        const channelId = msg.channelId;
        if (!channelId) return;

        const emoji = reaction.emoji.id
          ? reaction.emoji.toString()
          : (reaction.emoji.name ?? reaction.emoji.toString());
        if (!emoji) return;

        const chatType = resolveDiscordChatType(msg.guildId);
        const isThread =
          msg.channel &&
          "isThread" in msg.channel &&
          typeof msg.channel.isThread === "function" &&
          msg.channel.isThread();

        // In guilds, only react on messages in threads we're tracking
        if (chatType === "channel" && !isThread) return;

        // Apply channel allowlist gating in guilds (parent channel of the thread)
        if (
          chatType === "channel" &&
          isThread &&
          !isDiscordGuildChannelAllowed({
            channelId,
            parentChannelId:
              (msg.channel as { parentId?: string | null }).parentId ?? null,
            isThread: true,
            allowedChannels: config.allowedChannels,
          })
        )
          return;

        const inbound: InboundChannelMessage = {
          channel: "discord",
          accountId: config.accountId,
          chatId: channelId,
          senderId: user.id,
          senderName: user.username ?? undefined,
          text: "",
          timestamp: Date.now(),
          messageId: msg.id,
          threadId: isThread ? channelId : null,
          chatType,
          isMention: false,
          reaction: {
            action,
            emoji,
            targetMessageId: msg.id,
            targetSenderId: msg.author?.id,
          },
          raw: { reaction, user },
        };

        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error(`[Discord] Error handling reaction ${action}:`, error);
        }
      };

      client.on(
        "messageReactionAdd",
        async (reaction: DiscordReactionLike, user: DiscordUserLike) => {
          await handleReactionEvent(reaction, user, "added");
        },
      );

      client.on(
        "messageReactionRemove",
        async (reaction: DiscordReactionLike, user: DiscordUserLike) => {
          await handleReactionEvent(reaction, user, "removed");
        },
      );

      client.on("error", (err: unknown) => {
        console.error("[Discord] Client error:", err);
      });

      await client.login(config.token);
    },

    async stop(): Promise<void> {
      if (!running || !client) return;
      clearAllTyping();
      client.destroy();
      client = null;
      running = false;
      botUserId = null;
      seenIngressMessageKeys.clear();
      lifecycleStateByMessageKey.clear();
      lifecycleOperationByMessageKey.clear();
      lifecycleErrorReplyKeys.clear();
      console.log("[Discord] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;
      if (event.type === "queued") {
        if (config.acknowledgeMessageReaction) {
          await scheduleLifecycleTransition(event.source, "queued");
        }
        return;
      }
      if (event.type === "processing") {
        for (const source of event.sources) {
          await startTypingForSource(source);
        }
        return;
      }

      for (const source of event.sources) {
        stopTypingForSource(source);
      }

      const nextState: LifecycleState =
        event.outcome === "completed"
          ? "completed"
          : event.outcome === "cancelled"
            ? "cancelled"
            : "error";
      if (config.acknowledgeMessageReaction) {
        await Promise.all(
          event.sources.map((source) =>
            scheduleLifecycleTransition(source, nextState),
          ),
        );
      }

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) return;

      const uniqueReplySources = new Map<string, ChannelTurnSource>();
      for (const source of event.sources) {
        const key = getLifecycleReplyKey(source);
        if (!key || uniqueReplySources.has(key)) continue;
        uniqueReplySources.set(key, source);
      }

      await Promise.all(
        Array.from(uniqueReplySources.values()).map(async (source) => {
          try {
            await sendLifecycleErrorReply(source, errorText, event.runId);
          } catch (error) {
            console.warn(
              `[Discord] Failed to post lifecycle error for ${source.chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      if (!client) throw new Error("Discord not started");

      // Handle reactions
      if (msg.reaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error("Discord reactions require a target message ID.");
        }
        const emoji = resolveDiscordReactionEmoji(msg.reaction);
        const targetChannelId = msg.threadId ?? msg.chatId;
        const channel = await client.channels.fetch(targetChannelId);
        if (!hasDiscordMessageFetcher(channel)) {
          throw new Error(
            `Discord channel not found or not text-based: ${targetChannelId}`,
          );
        }
        const message = await channel.messages.fetch(targetMessageId);
        if (msg.removeReaction) {
          const resolved = message.reactions.resolve?.(emoji) ?? null;
          if (resolved && botUserId) {
            await resolved.users.remove(botUserId);
          }
        } else {
          await message.react(emoji);
        }
        clearTypingForChannel(targetChannelId);
        return { messageId: targetMessageId };
      }

      // Handle file uploads
      if (msg.mediaPath) {
        const targetChannelId = msg.threadId ?? msg.chatId;
        const channel = await client.channels.fetch(targetChannelId);
        if (!isDiscordSendableChannel(channel)) {
          throw new Error(
            `Discord channel not found or not text-based: ${targetChannelId}`,
          );
        }
        const reply = buildDiscordReplyOptions(
          msg.replyToMessageId,
          targetChannelId,
        );
        const result = await channel.send({
          content: msg.text?.trim() || undefined,
          ...(reply ?? {}),
          files: [
            {
              attachment: msg.mediaPath,
              name: msg.fileName ?? basename(msg.mediaPath),
            },
          ],
        });
        clearTypingForChannel(targetChannelId);
        return { messageId: result.id };
      }

      // Handle text messages
      const targetChannelId = msg.threadId ?? msg.chatId;
      const channel = await client.channels.fetch(targetChannelId);
      if (!isDiscordSendableChannel(channel)) {
        throw new Error(
          `Discord channel not found or not text-based: ${targetChannelId}`,
        );
      }
      const reply = buildDiscordReplyOptions(
        msg.replyToMessageId,
        targetChannelId,
      );
      const chunks = splitMessageText(msg.text, DISCORD_SPLIT_THRESHOLD);
      let lastMessageId = "";
      for (const chunk of chunks) {
        const result = await channel.send({
          content: chunk,
          ...(reply ?? {}),
        });
        lastMessageId = result.id;
      }
      clearTypingForChannel(targetChannelId);
      return { messageId: lastMessageId };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      if (!client) throw new Error("Discord not started");
      const channel = await client.channels.fetch(chatId);
      if (!isDiscordSendableChannel(channel)) {
        return;
      }
      const reply = buildDiscordReplyOptions(options?.replyToMessageId, chatId);
      await channel.send({
        content: text,
        ...(reply ?? {}),
      });
      clearTypingForChannel(chatId);
    },

    async prepareInboundMessage(
      msg: InboundChannelMessage,
      options?: { isFirstRouteTurn?: boolean },
    ): Promise<InboundChannelMessage> {
      if (
        !options?.isFirstRouteTurn ||
        msg.channel !== "discord" ||
        msg.chatType !== "channel" ||
        !isNonEmptyString(msg.threadId) ||
        !client
      ) {
        return msg;
      }

      const starter = await resolveDiscordThreadStarter({
        client,
        threadChannelId: msg.threadId,
      });
      const history = await resolveDiscordThreadHistory({
        client,
        threadChannelId: msg.threadId,
        currentMessageId: msg.messageId,
        limit: INITIAL_THREAD_HISTORY_LIMIT,
      });

      if (!starter && history.length === 0) {
        return msg;
      }

      const label = msg.chatLabel
        ? `Discord thread in ${msg.chatLabel}`
        : `Discord thread ${msg.chatId}`;

      return {
        ...msg,
        threadContext: {
          label,
          ...(starter
            ? {
                starter: {
                  messageId: starter.id,
                  senderId: starter.userId ?? starter.botId,
                  text: starter.text,
                },
              }
            : {}),
          ...(history.length > 0
            ? {
                history: history.map((entry) => ({
                  messageId: entry.id,
                  senderId: entry.userId ?? entry.botId,
                  text: entry.text,
                })),
              }
            : {}),
        },
      };
    },

    onMessage: undefined,
  };

  return adapter;
}
