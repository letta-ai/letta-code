import type { ChannelTurnSource } from "@/channels/types";
import {
  SYSTEM_TYPING_CONTROLLER_TIMERS,
  type TypingControllerTimers,
} from "@/channels/typing-controller-timers";
import type { TelegramTypingEntry } from "./internal-types";
import { TELEGRAM_TYPING_MAX_MS, TELEGRAM_TYPING_REFRESH_MS } from "./utils";

const OUTBOUND_TYPING_SUPPRESSION_MS = 1_000;

export function createTelegramTypingController(deps: {
  sendTypingAction: (chatId: string, threadId: string | null) => Promise<void>;
  timers?: TypingControllerTimers;
}) {
  const timers = deps.timers ?? SYSTEM_TYPING_CONTROLLER_TIMERS;
  const typingByTarget = new Map<string, TelegramTypingEntry>();
  const lastOutboundAtByTarget = new Map<string, number>();

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

  function getTargetKey(source: ChannelTurnSource): string | null {
    const chatId = getChatId(source);
    if (!chatId) return null;
    return targetKey(chatId, source.threadId);
  }

  function targetKey(
    chatId: string,
    threadId: string | null | undefined,
  ): string {
    return [chatId, threadId ?? ""].join(":");
  }

  function clearTarget(targetKey: string): void {
    const entry = typingByTarget.get(targetKey);
    if (!entry) return;
    timers.clearInterval(entry.timer);
    timers.clearTimeout(entry.timeout);
    typingByTarget.delete(targetKey);
    lastOutboundAtByTarget.delete(targetKey);
  }

  function touchWatchdog(targetKey: string): void {
    const entry = typingByTarget.get(targetKey);
    if (!entry) return;
    timers.clearTimeout(entry.timeout);
    entry.timeout = timers.setTimeout(
      () => clearTarget(targetKey),
      TELEGRAM_TYPING_MAX_MS,
    );
    entry.timeout.unref?.();
  }

  function start(source: ChannelTurnSource): void {
    const chatId = getChatId(source);
    const targetKey = getTargetKey(source);
    const sourceKey = getSourceKey(source);
    if (!chatId || !targetKey || !sourceKey) return;
    const threadId = source.threadId ?? null;
    const existing = typingByTarget.get(targetKey);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      touchWatchdog(targetKey);
      return;
    }

    void deps.sendTypingAction(chatId, threadId);
    const timer = timers.setInterval(() => {
      const lastOutboundAt = lastOutboundAtByTarget.get(targetKey) ?? 0;
      if (Date.now() - lastOutboundAt < OUTBOUND_TYPING_SUPPRESSION_MS) return;
      void deps.sendTypingAction(chatId, threadId);
    }, TELEGRAM_TYPING_REFRESH_MS);
    const timeout = timers.setTimeout(
      () => clearTarget(targetKey),
      TELEGRAM_TYPING_MAX_MS,
    );
    timer.unref?.();
    timeout.unref?.();
    typingByTarget.set(targetKey, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout,
    });
  }

  function markOutbound(
    chatId: string,
    threadId: string | null | undefined,
  ): void {
    const key = targetKey(chatId, threadId);
    if (!typingByTarget.has(key)) return;
    lastOutboundAtByTarget.set(key, Date.now());
    touchWatchdog(key);
  }

  function stop(source: ChannelTurnSource): void {
    const targetKey = getTargetKey(source);
    const sourceKey = getSourceKey(source);
    if (!targetKey || !sourceKey) return;
    const entry = typingByTarget.get(targetKey);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) clearTarget(targetKey);
  }

  function clearAll(): void {
    for (const entry of typingByTarget.values()) {
      timers.clearInterval(entry.timer);
      timers.clearTimeout(entry.timeout);
    }
    typingByTarget.clear();
    lastOutboundAtByTarget.clear();
  }

  return { clearAll, getChatId, markOutbound, start, stop };
}
