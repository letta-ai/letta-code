import { basename } from "node:path";
import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "../inboundDebounce";
import type {
  ChannelAdapter,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  DiscordChannelAccount,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "../types";
import {
  isDiscordGuildChannelAllowed,
  resolveDiscordChannelMode,
} from "./channelGating";
import {
  buildDiscordDebounceKey,
  type DiscordDebounceRawInput,
  resolveDiscordInboundDebounceMs,
} from "./debounce";
import { formatDiscordDeliveryError } from "./errorReply";
import {
  resolveDiscordInboundAttachments,
  resolveDiscordThreadHistory,
  resolveDiscordThreadStarter,
} from "./media";
import { type DiscordRuntimeModuleLike, loadDiscordModule } from "./runtime";

type DiscordEventHandlerResult = void | Promise<void>;

interface DiscordUserLike {
  id: string;
  username?: string | null;
  globalName?: string | null;
  tag?: string | null;
  bot?: boolean;
}

interface DiscordGuildMemberLike {
  displayName?: string | null;
}

interface DiscordAttachmentLike {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  url: string;
}

interface DiscordMentionsLike {
  has: (user: DiscordUserLike | null | undefined) => boolean;
}

interface DiscordReactionResolutionLike {
  me?: boolean;
  remove?: () => Promise<unknown>;
  users: {
    remove: (userId: string) => Promise<unknown>;
  };
}

interface DiscordReactionStoreLike {
  cache: Map<string, DiscordReactionResolutionLike>;
  resolve?: (emoji: string) => DiscordReactionResolutionLike | null;
}

interface DiscordFetchedMessageLike {
  id: string;
  content?: string | null;
  author?: DiscordUserLike;
  partial?: boolean;
  fetch?: () => Promise<DiscordFetchedMessageLike>;
  react: (emoji: string) => Promise<unknown>;
  reactions: DiscordReactionStoreLike;
}

interface DiscordThreadLike {
  id: string;
  name?: string | null;
}

interface DiscordChannelLike {
  name?: string | null;
  parentId?: string | null;
  isTextBased?: () => boolean;
  isThread?: () => boolean;
  send?: (options: string | Record<string, unknown>) => Promise<{ id: string }>;
  sendTyping?: () => Promise<unknown>;
  messages?: {
    fetch: (id: string) => Promise<DiscordFetchedMessageLike>;
  };
}

interface DiscordMessageLike extends DiscordFetchedMessageLike {
  channelId: string;
  guildId?: string | null;
  author: DiscordUserLike;
  member?: DiscordGuildMemberLike | null;
  channel: DiscordChannelLike;
  mentions: DiscordMentionsLike;
  attachments: Map<string, DiscordAttachmentLike>;
  createdTimestamp: number;
  startThread: (options: {
    name: string;
    reason?: string;
  }) => Promise<DiscordThreadLike>;
}

interface DiscordReactionLike {
  partial?: boolean;
  fetch: () => Promise<unknown>;
  message: DiscordMessageLike;
  emoji: {
    id?: string | null;
    name?: string | null;
    toString: () => string;
  };
}

interface DiscordEventHandlerMap {
  ready: () => DiscordEventHandlerResult;
  messageCreate: (message: DiscordMessageLike) => DiscordEventHandlerResult;
  messageReactionAdd: (
    reaction: DiscordReactionLike,
    user: DiscordUserLike,
  ) => DiscordEventHandlerResult;
  messageReactionRemove: (
    reaction: DiscordReactionLike,
    user: DiscordUserLike,
  ) => DiscordEventHandlerResult;
  error: (error: unknown) => DiscordEventHandlerResult;
}

interface DiscordClient {
  user?: DiscordUserLike | null;
  channels: {
    fetch: (id: string) => Promise<DiscordChannelLike | null>;
  };
  once<K extends keyof DiscordEventHandlerMap>(
    event: K,
    handler: DiscordEventHandlerMap[K],
  ): DiscordClient;
  on<K extends keyof DiscordEventHandlerMap>(
    event: K,
    handler: DiscordEventHandlerMap[K],
  ): DiscordClient;
  login: (token: string) => Promise<unknown>;
  destroy: () => void;
}

type DiscordMessage = DiscordMessageLike;

const DISCORD_SPLIT_THRESHOLD = 1900;
const INGRESS_DEDUPE_TTL_MS = 60_000;
const INGRESS_DEDUPE_MAX = 2_000;
const LIFECYCLE_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LIFECYCLE_STATE_MAX = 2_000;
const DISCORD_LIFECYCLE_ERROR_TEXT_MAX = 1500;
const INITIAL_THREAD_HISTORY_LIMIT = 20;

type LifecycleState = "queued" | "completed" | "error" | "cancelled";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDiscordTextChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
} {
  return typeof channel?.isTextBased === "function" && channel.isTextBased();
}

function hasDiscordMessageFetcher(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  messages: {
    fetch: (id: string) => Promise<DiscordFetchedMessageLike>;
  };
} {
  return (
    isDiscordTextChannel(channel) &&
    !!channel.messages &&
    typeof channel.messages.fetch === "function"
  );
}

function isDiscordSendableChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  send: (options: string | Record<string, unknown>) => Promise<{ id: string }>;
} {
  return isDiscordTextChannel(channel) && typeof channel.send === "function";
}

function splitMessageText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline boundary
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function normalizeDiscordMentionText(
  text: string,
  botUserId: string | null,
): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "").trim();
}

function resolveDiscordChatType(
  guildId: string | null | undefined,
): "direct" | "channel" {
  return guildId ? "channel" : "direct";
}

/**
 * Resolve native emoji for Discord reactions.
 * Discord uses native Unicode emoji directly (not names like Slack).
 * Strip colons for common named patterns.
 */
function resolveDiscordReactionEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<:") || trimmed.startsWith("<a:")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^:+|:+$/g, "");
  // Common name-to-emoji mappings for parity with Slack lifecycle reactions
  const nameMap: Record<string, string> = {
    eyes: "👀",
    white_check_mark: "✅",
    x: "❌",
  };
  return nameMap[normalized] ?? normalized;
}

export function buildDiscordIngressMessageKey(
  accountId: string | undefined,
  messageId: string | undefined,
): string | null {
  if (!isNonEmptyString(accountId) || !isNonEmptyString(messageId)) {
    return null;
  }
  return `${accountId}:${messageId}`;
}

export function buildDiscordReplyOptions(
  replyToMessageId: string | undefined,
  channelId: string,
): { reply: { messageReference: string; failIfNotExists: false } } | undefined {
  const trimmed = replyToMessageId?.trim();
  if (!trimmed || trimmed === channelId) {
    return undefined;
  }
  return {
    reply: {
      messageReference: trimmed,
      failIfNotExists: false,
    },
  };
}

function formatDiscordLifecycleErrorMessage(errorText: string): string {
  const normalized = errorText.trim() || "Unknown error";
  const truncated =
    normalized.length > DISCORD_LIFECYCLE_ERROR_TEXT_MAX
      ? `${normalized
          .slice(0, DISCORD_LIFECYCLE_ERROR_TEXT_MAX - 1)
          .trimEnd()}…`
      : normalized;
  return `Turn failed:\n\`\`\`\n${truncated.replace(/```/g, "``\u200b`")}\n\`\`\``;
}

/**
 * Best-effort: post a user-facing error reply when forwarding a Discord
 * message to the agent runtime fails. Swallows any send failure so the
 * notification path can never crash the listener.
 */
async function notifyDiscordDeliveryError(
  message: DiscordMessageLike,
  error: unknown,
): Promise<void> {
  try {
    if (typeof message.channel.send !== "function") return;
    const reply = buildDiscordReplyOptions(message.id, message.channelId);
    await message.channel.send({
      allowedMentions: { parse: [] },
      content: formatDiscordDeliveryError(error),
      ...(reply ?? {}),
    });
  } catch (sendError) {
    console.error(
      "[Discord] Failed to forward delivery error to user:",
      sendError,
    );
  }
}

export async function resolveDiscordAccountDisplayName(
  token: string,
): Promise<string | undefined> {
  const discord = await loadDiscordModule();
  const client = new discord.Client({
    intents: [discord.GatewayIntentBits.Guilds],
  }) as DiscordClient;
  try {
    await client.login(token);
    const tag = client.user?.tag ?? client.user?.username;
    client.destroy();
    return tag ?? undefined;
  } catch {
    try {
      client.destroy();
    } catch {}
    return undefined;
  }
}

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

  // ── Inbound debounce (open-channel guild messages only) ──────────
  const debounceMs = resolveDiscordInboundDebounceMs(config);

  type DiscordDebounceEntry = {
    inbound: InboundChannelMessage;
    raw: DiscordDebounceRawInput;
    isOpenChannel: boolean;
  };

  const debouncer: InboundDebouncer<DiscordDebounceEntry> =
    createInboundDebouncer<DiscordDebounceEntry>({
      debounceMs,
      buildKey: ({ raw }) => buildDiscordDebounceKey(raw, config.accountId),
      shouldDebounce: ({ inbound, isOpenChannel }) =>
        isOpenChannel &&
        !inbound.isMention &&
        !inbound.attachments?.length &&
        !inbound.reaction,
      onFlush: async (entries) => {
        if (entries.length === 0) return;
        const last = entries[entries.length - 1]!;

        // Merge text with sender labels if multiple senders
        let combinedText: string;
        if (entries.length === 1) {
          combinedText = last.inbound.text;
        } else {
          const uniqueSenders = new Set(entries.map((e) => e.inbound.senderId));
          if (uniqueSenders.size > 1) {
            combinedText = entries
              .map(
                (entry) =>
                  `[${entry.inbound.senderName ?? entry.inbound.senderId}]: ${entry.inbound.text}`,
              )
              .filter((text) => text && text.length > 0)
              .join("\n");
          } else {
            combinedText = entries
              .map((entry) => entry.inbound.text)
              .filter((text) => text && text.length > 0)
              .join("\n");
          }
        }

        const merged: InboundChannelMessage = {
          ...last.inbound,
          text: combinedText,
        };

        if (!adapter.onMessage) return;
        try {
          await withTypingIndicator(last.inbound.chatId, () =>
            adapter.onMessage!(merged),
          );
        } catch (error) {
          console.error(
            "[Discord] Error handling debounced inbound message:",
            error,
          );
        }
      },
      onError: (err) => {
        console.error(
          "[Discord] Inbound debounce flush failed:",
          err instanceof Error ? err.message : err,
        );
      },
    });

  const TYPING_INTERVAL_MS = 8_000;

  /**
   * Track which chats have an active typing indicator so overlapping calls
   * for the same channel reuse the existing interval instead of doubling up.
   */
  const activeTypingChats = new Set<string>();

  /**
   * Trigger Discord typing indicator in the given channel before executing
   * `fn`, then re-trigger every ~8s (before Discord's 10s expiry) until
   * `fn` resolves. Non-throwing — typing failures are silently swallowed.
   *
   * Debounce note: typing starts at debounce flush time (when the buffered
   * messages are dispatched to the LLM). If the debounce window itself feels
   * idle, typing could be triggered earlier — when the first message enters
   * the buffer — as a future enhancement.
   */
  async function withTypingIndicator(
    chatId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (!client) return fn();

    // Race/overlap guard: if an interval is already active for this chat,
    // skip creating a second one. The existing interval covers us.
    if (activeTypingChats.has(chatId)) return fn();

    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      const channel = await client.channels.fetch(chatId);
      if (channel?.sendTyping) {
        activeTypingChats.add(chatId);
        await channel.sendTyping().catch(() => {});
        interval = setInterval(() => {
          channel.sendTyping?.().catch(() => {});
        }, TYPING_INTERVAL_MS);
        // Don't let the interval pin the Node process.
        interval.unref?.();
      }
    } catch (err) {
      // Typing is best-effort; never block message processing.
      console.debug(
        "[Discord] Typing indicator failed for channel %s: %s",
        chatId,
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      await fn();
    } finally {
      if (interval) clearInterval(interval);
      activeTypingChats.delete(chatId);
    }
  }

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
      content: formatDiscordLifecycleErrorMessage(errorText),
      ...(reply ?? {}),
    });
  }

  function scheduleLifecycleTransition(
    source: ChannelTurnSource,
    nextState: LifecycleState,
  ): Promise<void> | null {
    const key = getLifecycleMessageKey(source);
    if (!key) return null;
    if (!config.acknowledgeMessageReaction) return null;
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
          `[Discord] Bot logged in as ${tag} (dm_policy: ${config.dmPolicy}, autoThreadOnMention: ${config.autoThreadOnMention ?? false}, inboundDebounceMs: ${debounceMs})`,
        );
        running = true;
      });

      client.on("messageCreate", async (message: DiscordMessage) => {
        if (!adapter.onMessage) return;

        // Ignore bot messages (including self)
        if (message.author.bot) return;

        const content = (message.content ?? "").trim();
        const userId = message.author.id;
        if (!userId) return;

        const chatType = resolveDiscordChatType(message.guildId);
        const isThread = isThreadMessage(message);
        const wasMentioned = chatType === "channel" && hasBotMention(message);

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
            await withTypingIndicator(message.channelId, () =>
              adapter.onMessage!(inbound),
            );
          } catch (error) {
            console.error("[Discord] Error handling DM:", error);
            await notifyDiscordDeliveryError(message, error);
          }
          return;
        }

        // ── Guild handling ────────────────────────────────────────
        // Inside a thread: surface messages and let the registry decide whether
        // the thread is already routed, or whether a new mention is required.
        // Outside a thread:
        //   - "open" channels: process every non-bot message (no @mention needed)
        //   - "mention-only" channels (or no gate): only process @mentions

        const parentChannelId =
          (message.channel as { parentId?: string | null }).parentId ?? null;
        const channelMode = resolveDiscordChannelMode(
          message.channelId,
          parentChannelId,
          isThread,
          config.allowedChannels,
        );

        // For non-thread messages, check if the channel is in "open" mode
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
        // Track the true parent guild channel for delivery-time gating.
        // For existing threads this is the thread's parentId; for newly
        // created threads it is the original guild channel the mention
        // arrived in.
        let resolvedParentChannelId = isThread
          ? parentChannelId
          : message.channelId;

        // If mentioned outside a thread and thread creation is enabled,
        // create a Discord thread for the conversation.
        // Resolution order: per-channel override → account-level
        // autoThreadOnMention → disabled (default).
        const shouldAutoThread =
          config.threadPolicyByChannel?.[message.channelId] ??
          config.autoThreadOnMention ??
          false;
        if (!isThread && wasMentioned && shouldAutoThread) {
          const createdThread = await createThreadForMention(message, content);
          if (!createdThread) return;
          effectiveChatId = createdThread.id;
          effectiveThreadId = createdThread.id;
          // The newly created thread's parent is the original guild channel
          resolvedParentChannelId = message.channelId;
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
          parentChannelId: resolvedParentChannelId ?? undefined,
          chatType: "channel",
          isMention: wasMentioned || isOpenChannel,
          attachments,
          raw: message,
        };

        try {
          // Open-channel non-mention messages go through the debounce pipeline.
          // Mentions, DMs, attachments, and reactions always bypass.
          const shouldDebounce =
            isOpenChannel &&
            !wasMentioned &&
            debounceMs > 0 &&
            !attachments?.length;

          if (shouldDebounce) {
            await debouncer.enqueue({
              inbound,
              raw: {
                channelId: effectiveChatId,
                threadId: effectiveThreadId,
              },
              isOpenChannel,
            });
          } else {
            await withTypingIndicator(effectiveChatId, () =>
              adapter.onMessage!(inbound),
            );
          }
        } catch (error) {
          console.error("[Discord] Error handling guild message:", error);
          await notifyDiscordDeliveryError(message, error);
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

        // In guilds, only react on messages in threads or open channels
        const reactionParentChannelId =
          (msg.channel as { parentId?: string | null }).parentId ?? null;
        const reactionChannelMode = resolveDiscordChannelMode(
          channelId,
          reactionParentChannelId,
          isThread,
          config.allowedChannels,
        );
        if (
          chatType === "channel" &&
          !isThread &&
          reactionChannelMode !== "open"
        )
          return;

        // Apply channel allowlist gating in guilds
        if (
          chatType === "channel" &&
          !isDiscordGuildChannelAllowed({
            channelId,
            parentChannelId: reactionParentChannelId,
            isThread,
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
        await scheduleLifecycleTransition(event.source, "queued");
        return;
      }
      if (event.type === "processing") return;
      const nextState: LifecycleState =
        event.outcome === "completed"
          ? "completed"
          : event.outcome === "cancelled"
            ? "cancelled"
            : "error";
      await Promise.all(
        event.sources.map((source) =>
          scheduleLifecycleTransition(source, nextState),
        ),
      );

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
            await sendLifecycleErrorReply(source, errorText);
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
