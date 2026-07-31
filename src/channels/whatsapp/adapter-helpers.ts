import type {
  ChannelTurnSource,
  WhatsAppChannelAccount,
} from "@/channels/types";
import { stripDeviceSuffix } from "./jid";
import { unwrapWhatsAppMessageContent } from "./media";

const MAX_MENTION_PATTERN_LENGTH = 256;
const MENTION_MATCH_TEXT_MAX_LENGTH = 2000;

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

function matchesSelf(
  jid: string,
  selfPhoneJid: string | null,
  selfLid: string | null,
): boolean {
  const normalized = stripDeviceSuffix(jid);
  return (
    (!!selfPhoneJid && normalized === stripDeviceSuffix(selfPhoneJid)) ||
    (!!selfLid && normalized === stripDeviceSuffix(selfLid))
  );
}

export function shouldProcessWhatsAppGroup(params: {
  account: WhatsAppChannelAccount;
  groupJid: string;
  text: string;
  mentionedJids: string[];
  replyParticipant: string | null;
  selfPhoneJid: string | null;
  selfLid: string | null;
}): boolean {
  const {
    account,
    groupJid,
    text,
    mentionedJids,
    replyParticipant,
    selfPhoneJid,
    selfLid,
  } = params;
  if (account.groupMode === "disabled") return false;
  if (
    account.allowedGroups?.length &&
    !account.allowedGroups.includes(groupJid)
  ) {
    return false;
  }
  if (account.groupMode === "open") return true;
  if (mentionedJids.some((jid) => matchesSelf(jid, selfPhoneJid, selfLid))) {
    return true;
  }
  if (
    replyParticipant &&
    matchesSelf(replyParticipant, selfPhoneJid, selfLid)
  ) {
    return true;
  }
  const matchText = text.slice(0, MENTION_MATCH_TEXT_MAX_LENGTH);
  for (const pattern of account.mentionPatterns ?? []) {
    if (pattern.length > MAX_MENTION_PATTERN_LENGTH) continue;
    try {
      if (new RegExp(pattern, "i").test(matchText)) return true;
    } catch {
      // Ignore invalid user-provided patterns.
    }
  }
  return false;
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
