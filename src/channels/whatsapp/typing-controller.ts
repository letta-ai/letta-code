import type { ChannelTurnSource } from "@/channels/types";

export type WhatsAppTypingPresence = "composing" | "paused";

export interface WhatsAppTypingControllerOptions {
  accountId: string;
  canonicalizeChatId: (chatId: string) => string | null;
  sendPresence: (chatId: string, presence: WhatsAppTypingPresence) => unknown;
  refreshMs?: number;
  maxLifetimeMs?: number;
}

export interface WhatsAppTypingController {
  start(source: ChannelTurnSource): void;
  stop(source: ChannelTurnSource): Promise<void>;
  isActive(chatId: string): boolean;
  clearChat(
    chatId: string,
    options?: WhatsAppTypingClearOptions,
  ): Promise<void>;
  clearAll(options?: WhatsAppTypingClearOptions): Promise<void>;
}

export interface WhatsAppTypingClearOptions {
  sendPaused?: boolean;
}

interface TypingEntry {
  sourceKeys: Set<string>;
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

export function createWhatsAppTypingController(
  options: WhatsAppTypingControllerOptions,
): WhatsAppTypingController {
  const refreshMs = timing(options.refreshMs, DEFAULT_REFRESH_MS);
  const maxLifetimeMs = timing(options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS);
  const typingByChatId = new Map<string, TypingEntry>();

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

  function sourceKey(source: ChannelTurnSource, chatId: string): string {
    return [
      options.accountId,
      chatId,
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
    chatId: string,
    presence: WhatsAppTypingPresence,
  ): Promise<void> {
    try {
      await Promise.resolve(options.sendPresence(chatId, presence));
    } catch (error) {
      reportPresenceError(error);
    }
  }

  function sendPresenceFireAndForget(
    chatId: string,
    presence: WhatsAppTypingPresence,
  ): void {
    void sendPresence(chatId, presence);
  }

  async function clearChat(
    chatId: string,
    clearOptions: WhatsAppTypingClearOptions = {},
  ): Promise<void> {
    const canonical = canonicalChatId(chatId);
    if (!canonical) return;
    const entry = typingByChatId.get(canonical);
    if (!entry) return;
    clearInterval(entry.refreshTimer);
    clearTimeout(entry.maxTimer);
    typingByChatId.delete(canonical);
    if (clearOptions.sendPaused !== false) {
      await sendPresence(canonical, "paused");
    }
  }

  function start(source: ChannelTurnSource): void {
    const chatId = sourceChatId(source);
    if (!chatId) return;
    const key = sourceKey(source, chatId);
    const existing = typingByChatId.get(chatId);
    if (existing) {
      existing.sourceKeys.add(key);
      return;
    }

    const refreshTimer = setInterval(() => {
      sendPresenceFireAndForget(chatId, "composing");
    }, refreshMs);
    const maxTimer = setTimeout(() => {
      void clearChat(chatId);
    }, maxLifetimeMs);
    refreshTimer.unref?.();
    maxTimer.unref?.();
    typingByChatId.set(chatId, {
      sourceKeys: new Set([key]),
      refreshTimer,
      maxTimer,
    });
    sendPresenceFireAndForget(chatId, "composing");
  }

  async function stop(source: ChannelTurnSource): Promise<void> {
    const chatId = sourceChatId(source);
    if (!chatId) return;
    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey(source, chatId));
    if (entry.sourceKeys.size === 0) await clearChat(chatId);
  }

  function isActive(chatId: string): boolean {
    const canonical = canonicalChatId(chatId);
    return canonical !== null && typingByChatId.has(canonical);
  }

  async function clearAll(
    clearOptions: WhatsAppTypingClearOptions = {},
  ): Promise<void> {
    const chats = [...typingByChatId.keys()];
    await Promise.all(chats.map((chatId) => clearChat(chatId, clearOptions)));
  }

  return { start, stop, isActive, clearChat, clearAll };
}
