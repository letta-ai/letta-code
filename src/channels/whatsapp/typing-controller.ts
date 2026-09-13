import type { ChannelTurnSource } from "@/channels/types";

export type WhatsAppTypingPresence = "composing" | "paused";

export interface WhatsAppTypingTurn {
  batchId: string;
  source: ChannelTurnSource;
}

export interface WhatsAppTypingControllerOptions<Owner> {
  accountId: string;
  canonicalizeChatId: (chatId: string) => string | null;
  getOwner: () => Owner | null | undefined;
  sendPresence: (
    owner: Owner,
    chatId: string,
    presence: WhatsAppTypingPresence,
  ) => unknown;
  refreshMs?: number;
  maxLifetimeMs?: number;
}

export interface WhatsAppTypingController<Owner = unknown> {
  start(turn: WhatsAppTypingTurn): void;
  stop(turn: WhatsAppTypingTurn): Promise<void>;
  isActive(chatId: string): boolean;
  clearChat(
    chatId: string,
    options?: WhatsAppTypingClearOptions<Owner>,
  ): Promise<void>;
  clearOwner(
    owner: Owner,
    options?: WhatsAppTypingClearOptions<Owner>,
  ): Promise<void>;
  clearAll(options?: WhatsAppTypingClearOptions<Owner>): Promise<void>;
}

export interface WhatsAppTypingClearOptions<Owner = unknown> {
  sendPaused?: boolean;
  owner?: Owner;
}

interface TypingEntry<Owner> {
  batchId: string;
  sourceKeys: Set<string>;
  owner: Owner;
  refreshTimer: ReturnType<typeof setInterval>;
  maxTimer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REFRESH_MS = 12_000;
const DEFAULT_MAX_LIFETIME_MS = 5 * 60_000;

function timing(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function createWhatsAppTypingController<Owner>(
  options: WhatsAppTypingControllerOptions<Owner>,
): WhatsAppTypingController<Owner> {
  const refreshMs = timing(options.refreshMs, DEFAULT_REFRESH_MS);
  const maxLifetimeMs = timing(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS);
  const typingByChatId = new Map<string, TypingEntry<Owner>>();

  function canonicalChatId(chatId: string): string | null {
    if (!chatId) return null;
    try {
      return options.canonicalizeChatId(chatId);
    } catch {
      return null;
    }
  }

  function sourceChatId(source: ChannelTurnSource): string | null {
    if (
      source.channel !== "whatsapp" ||
      source.accountId !== options.accountId
    ) {
      return null;
    }
    return canonicalChatId(source.chatId);
  }

  function sourceKey(turn: WhatsAppTypingTurn, chatId: string): string {
    const { source } = turn;
    return [
      options.accountId,
      chatId,
      turn.batchId,
      source.threadId ?? "",
      source.messageId ?? "",
      source.agentId,
      source.conversationId,
    ].join(":");
  }

  function reportPresenceError(error: unknown): void {
    void error;
  }

  async function sendPresence(
    owner: Owner,
    chatId: string,
    presence: WhatsAppTypingPresence,
  ): Promise<void> {
    try {
      await Promise.resolve(options.sendPresence(owner, chatId, presence));
    } catch (error) {
      reportPresenceError(error);
    }
  }

  function sendPresenceFireAndForget(
    owner: Owner,
    chatId: string,
    presence: WhatsAppTypingPresence,
  ): void {
    void sendPresence(owner, chatId, presence);
  }

  async function clearChat(
    chatId: string,
    clearOptions: WhatsAppTypingClearOptions<Owner> = {},
  ): Promise<void> {
    const canonical = canonicalChatId(chatId);
    if (!canonical) return;
    const entry = typingByChatId.get(canonical);
    if (!entry) return;
    if (
      clearOptions.owner !== undefined &&
      entry.owner !== clearOptions.owner
    ) {
      return;
    }
    clearInterval(entry.refreshTimer);
    clearTimeout(entry.maxTimer);
    typingByChatId.delete(canonical);
    if (clearOptions.sendPaused !== false) {
      await sendPresence(entry.owner, canonical, "paused");
    }
  }

  function start(turn: WhatsAppTypingTurn): void {
    const chatId = sourceChatId(turn.source);
    if (!chatId) return;
    const owner = options.getOwner();
    if (owner === null || owner === undefined) return;
    const key = sourceKey(turn, chatId);
    const existing = typingByChatId.get(chatId);
    if (existing) {
      if (existing.owner === owner && existing.batchId === turn.batchId) {
        existing.sourceKeys.add(key);
        return;
      }
      void clearChat(chatId, { owner: existing.owner, sendPaused: false });
    }

    const refreshTimer = setInterval(() => {
      const entry = typingByChatId.get(chatId);
      if (!entry || entry.owner !== owner || entry.batchId !== turn.batchId) {
        return;
      }
      sendPresenceFireAndForget(owner, chatId, "composing");
    }, refreshMs);
    const maxTimer = setTimeout(() => {
      void clearChat(chatId, { owner });
    }, maxLifetimeMs);
    refreshTimer.unref?.();
    maxTimer.unref?.();
    typingByChatId.set(chatId, {
      batchId: turn.batchId,
      sourceKeys: new Set([key]),
      owner,
      refreshTimer,
      maxTimer,
    });
    sendPresenceFireAndForget(owner, chatId, "composing");
  }

  async function stop(turn: WhatsAppTypingTurn): Promise<void> {
    const chatId = sourceChatId(turn.source);
    if (!chatId) return;
    const entry = typingByChatId.get(chatId);
    if (!entry || entry.batchId !== turn.batchId) return;
    entry.sourceKeys.delete(sourceKey(turn, chatId));
    if (entry.sourceKeys.size === 0) {
      await clearChat(chatId, { owner: entry.owner });
    }
  }

  function isActive(chatId: string): boolean {
    const canonical = canonicalChatId(chatId);
    return canonical !== null && typingByChatId.has(canonical);
  }

  async function clearOwner(
    owner: Owner,
    clearOptions: WhatsAppTypingClearOptions<Owner> = {},
  ): Promise<void> {
    const chats = [...typingByChatId.entries()]
      .filter(([, entry]) => entry.owner === owner)
      .map(([chatId]) => chatId);
    await Promise.all(
      chats.map((chatId) => clearChat(chatId, { ...clearOptions, owner })),
    );
  }

  async function clearAll(
    clearOptions: WhatsAppTypingClearOptions<Owner> = {},
  ): Promise<void> {
    const chats = [...typingByChatId.keys()];
    await Promise.all(chats.map((chatId) => clearChat(chatId, clearOptions)));
  }

  return { start, stop, isActive, clearChat, clearOwner, clearAll };
}
