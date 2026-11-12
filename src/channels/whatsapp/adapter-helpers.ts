import type {
  ChannelTurnSource,
  WhatsAppChannelAccount,
} from "@/channels/types";
import { unwrapWhatsAppMessageContent } from "./media";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function isWhatsAppReactionMessage(message: unknown): boolean {
  const content = unwrapWhatsAppMessageContent(message);
  return !!content?.reactionMessage;
}

export function isWhatsAppConflictDisconnect(update: unknown): boolean {
  const record = asRecord(update);
  if (record.connection !== "close") return false;
  const lastDisconnect = asRecord(record.lastDisconnect);
  const error = asRecord(lastDisconnect.error);
  const output = asRecord(error.output);
  const statusCode = output.statusCode;
  const message = typeof error.message === "string" ? error.message : "";
  return (
    statusCode === 440 ||
    /\bconflict\b/i.test(message) ||
    /connection replaced/i.test(message)
  );
}

export function timestampToMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value * 1000;
  }
  if (value && typeof value === "object") {
    const toNumber = (value as { toNumber?: () => number }).toNumber;
    if (typeof toNumber === "function") {
      return toNumber.call(value) * 1000;
    }
  }
  return Date.now();
}

export function previewWhatsAppText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}

export function getWhatsAppDisplayName(
  account: WhatsAppChannelAccount,
): string {
  return account.displayName ?? "WhatsApp";
}

export function applyWhatsAppMessagePrefix(
  text: string,
  prefix: string | undefined,
): string {
  return prefix && text.trim().length > 0 ? `${prefix}${text}` : text;
}

export function withWhatsAppPayloadMessagePrefix(
  payload: Record<string, unknown>,
  prefix: string | undefined,
): Record<string, unknown> {
  if (!prefix) return payload;
  if (typeof payload.text === "string") {
    return {
      ...payload,
      text: applyWhatsAppMessagePrefix(payload.text, prefix),
    };
  }
  if (typeof payload.caption === "string") {
    return {
      ...payload,
      caption: applyWhatsAppMessagePrefix(payload.caption, prefix),
    };
  }
  return payload;
}

export function buildWhatsAppQuotedOptions(
  targetJid: string,
  replyToMessageId?: string,
): Record<string, unknown> | undefined {
  if (!replyToMessageId) return undefined;
  return {
    quoted: {
      key: { remoteJid: targetJid, id: replyToMessageId },
      message: { conversation: "" },
    },
  };
}

export function getWhatsAppLifecycleErrorReplyKey(
  source: ChannelTurnSource,
): string | null {
  if (!source.chatId) return null;
  return `${source.chatId}:${source.messageId ?? ""}`;
}
