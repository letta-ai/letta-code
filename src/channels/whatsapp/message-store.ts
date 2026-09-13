import { isGroupJid, stripDeviceSuffix } from "./jid";

const MESSAGE_STORE_MAX_SIZE = 5000;
const MESSAGE_STORE_TTL_MS = 24 * 60 * 60 * 1000;

type WhatsAppMessageStore = {
  messages: Map<string, unknown>;
  isSent: (messageId: string) => boolean;
  forgetSent: (messageId: string) => void;
  rememberStored: (messageId: string, message: unknown) => void;
  rememberSent: (messageId: string, message?: unknown) => void;
  clear: () => void;
  isKnownOutbound: (messageId: string) => boolean;
  buildReactionTargetKey: (
    targetJid: string,
    messageId: string,
  ) => Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function unrefTimeout(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

export function createWhatsAppMessageStore(
  canonicalizeChatId: (chatId: string) => string | null,
): WhatsAppMessageStore {
  const messages = new Map<string, unknown>();
  const sentMessageIds = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimer(messageId: string): void {
    const timer = timers.get(messageId);
    if (timer) clearTimeout(timer);
    timers.delete(messageId);
  }

  function drop(messageId: string): void {
    sentMessageIds.delete(messageId);
    messages.delete(messageId);
    clearTimer(messageId);
  }

  function scheduleExpiry(messageId: string): void {
    clearTimer(messageId);
    const timer = setTimeout(() => {
      sentMessageIds.delete(messageId);
      messages.delete(messageId);
      timers.delete(messageId);
    }, MESSAGE_STORE_TTL_MS);
    unrefTimeout(timer);
    timers.set(messageId, timer);
  }

  function cap(): void {
    while (messages.size > MESSAGE_STORE_MAX_SIZE) {
      const first = messages.keys().next().value;
      if (typeof first !== "string") break;
      drop(first);
    }
    while (sentMessageIds.size > MESSAGE_STORE_MAX_SIZE) {
      const first = sentMessageIds.values().next().value;
      if (typeof first !== "string") break;
      drop(first);
    }
  }

  function rememberStored(messageId: string, message: unknown): void {
    if (!messageId) return;
    messages.set(messageId, message);
    scheduleExpiry(messageId);
    cap();
  }

  function rememberSent(messageId: string, message?: unknown): void {
    if (!messageId) return;
    sentMessageIds.add(messageId);
    if (message !== undefined) messages.set(messageId, message);
    scheduleExpiry(messageId);
    cap();
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    messages.clear();
    sentMessageIds.clear();
  }

  function isKnownOutbound(messageId: string): boolean {
    if (sentMessageIds.has(messageId)) return true;
    const stored = messages.get(messageId);
    if (!stored) return false;
    return asRecord(asRecord(stored).key).fromMe === true;
  }

  function getStoredTargetKey(
    targetJid: string,
    messageId: string,
  ): Record<string, unknown> | null {
    const key = asRecord(asRecord(messages.get(messageId)).key);
    if (typeof key.id !== "string" || key.id !== messageId) return null;
    const remoteJid =
      typeof key.remoteJid === "string" ? stripDeviceSuffix(key.remoteJid) : "";
    if (!remoteJid) return null;
    const storedChatId = canonicalizeChatId(remoteJid);
    const requestedChatId = canonicalizeChatId(targetJid);
    if (!storedChatId || !requestedChatId || storedChatId !== requestedChatId) {
      throw new Error(
        "WhatsApp reaction target belongs to a different chat in the current adapter process.",
      );
    }
    return { ...key, remoteJid, id: messageId };
  }

  function buildReactionTargetKey(
    targetJid: string,
    messageId: string,
  ): Record<string, unknown> {
    const storedKey = getStoredTargetKey(targetJid, messageId);
    if (storedKey) return storedKey;
    if (isGroupJid(targetJid)) {
      throw new Error(
        "WhatsApp group reactions require the original target message key from the current adapter process; after restart, react only after the target message is observed again.",
      );
    }
    return { remoteJid: targetJid, id: messageId };
  }

  return {
    messages,
    isSent: (messageId) => sentMessageIds.has(messageId),
    forgetSent: (messageId) => sentMessageIds.delete(messageId),
    rememberStored,
    rememberSent,
    clear,
    isKnownOutbound,
    buildReactionTargetKey,
  };
}
