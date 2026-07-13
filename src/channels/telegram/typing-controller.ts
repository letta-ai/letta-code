import type { ChannelTurnSource } from "@/channels/types";
import type { TelegramTypingEntry } from "./internal-types";
import { TELEGRAM_TYPING_MAX_MS, TELEGRAM_TYPING_REFRESH_MS } from "./utils";

export function createTelegramTypingController(deps: {
  sendTypingAction: (chatId: string) => Promise<void>;
}) {
  const typingByChatId = new Map<string, TelegramTypingEntry>();

  function getChatId(source: ChannelTurnSource): string | null {
    if (source.channel !== "telegram") return null;
    const chatId = source.chatId;
    return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
  }

  function getSourceKey(source: ChannelTurnSource): string | null {
    const chatId = getChatId(source);
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

  function clearChat(chatId: string): void {
    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChatId.delete(chatId);
  }

  function start(source: ChannelTurnSource): void {
    const chatId = getChatId(source);
    const sourceKey = getSourceKey(source);
    if (!chatId || !sourceKey) return;
    const existing = typingByChatId.get(chatId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      return;
    }

    void deps.sendTypingAction(chatId);
    const timer = setInterval(() => {
      void deps.sendTypingAction(chatId);
    }, TELEGRAM_TYPING_REFRESH_MS);
    const timeout = setTimeout(() => clearChat(chatId), TELEGRAM_TYPING_MAX_MS);
    timer.unref?.();
    timeout.unref?.();
    typingByChatId.set(chatId, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout,
    });
  }

  function stop(source: ChannelTurnSource): void {
    const chatId = getChatId(source);
    const sourceKey = getSourceKey(source);
    if (!chatId || !sourceKey) return;
    const entry = typingByChatId.get(chatId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) clearChat(chatId);
  }

  function clearAll(): void {
    for (const entry of typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChatId.clear();
  }

  return { clearAll, clearChat, getChatId, start, stop };
}
