import type { WhatsAppGroupMode } from "@/channels/types";
import { isStrictLidJid, isStrictPhoneJid, stripDeviceSuffix } from "./jid";

export interface WhatsAppReactionKey {
  remoteJid: string;
  id: string;
  fromMe?: boolean;
  participant?: string;
  senderPn?: string;
  senderLid?: string;
  participantPn?: string;
  participantLid?: string;
  [key: string]: unknown;
}

export interface WhatsAppReaction {
  targetKey: WhatsAppReactionKey;
  reactionKey: WhatsAppReactionKey;
  chatId: string;
  reactionMessageId: string;
  targetMessageId: string;
  targetFromMe: boolean;
  reactorParticipant?: string;
  action: "added" | "removed";
  emoji: string;
  timestampMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function canonicalChatJid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = stripDeviceSuffix(value.trim());
  if (!normalized) return null;
  const isGroup = /^\d[\d-]*@g\.us$/.test(normalized);
  if (
    !isGroup &&
    !isStrictPhoneJid(normalized) &&
    !isStrictLidJid(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseKey(value: unknown): WhatsAppReactionKey | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return null;
  }
  if (value.fromMe !== undefined && typeof value.fromMe !== "boolean") {
    return null;
  }
  const optionalJidFields = [
    "participant",
    "senderPn",
    "senderLid",
    "participantPn",
    "participantLid",
  ] as const;
  for (const field of optionalJidFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return null;
    }
  }
  return {
    ...value,
    id: value.id,
    remoteJid: typeof value.remoteJid === "string" ? value.remoteJid : "",
    ...(value.fromMe === undefined ? {} : { fromMe: value.fromMe }),
    ...Object.fromEntries(
      optionalJidFields.flatMap((field) =>
        value[field] === undefined ? [] : [[field, value[field]]],
      ),
    ),
  };
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (!isRecord(value) || typeof value.toNumber !== "function") {
    return undefined;
  }
  try {
    const numeric = value.toNumber();
    return typeof numeric === "number" &&
      Number.isFinite(numeric) &&
      numeric >= 0
      ? numeric
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse one Baileys `messages.reaction` entry without resolving identities. */
export function parseWhatsAppReactionEntry(
  entry: unknown,
): WhatsAppReaction | null {
  try {
    if (!isRecord(entry) || !isRecord(entry.reaction)) return null;
    const targetKey = parseKey(entry.key);
    const reactionKey = parseKey(entry.reaction.key);
    if (!targetKey || !reactionKey) return null;

    const targetChatId = canonicalChatJid(targetKey.remoteJid);
    const reactionChatId = canonicalChatJid(reactionKey.remoteJid);
    if (!targetChatId || targetChatId !== reactionChatId) return null;

    const text = entry.reaction.text;
    if (text !== null && text !== undefined && typeof text !== "string") {
      return null;
    }
    const emoji = typeof text === "string" ? text.trim() : "";
    if (emoji.length > 64) return null;

    return {
      targetKey: {
        ...targetKey,
        remoteJid: targetChatId,
        id: targetKey.id,
      },
      reactionKey: {
        ...reactionKey,
        remoteJid: targetChatId,
        id: reactionKey.id,
      },
      chatId: targetChatId,
      reactionMessageId: reactionKey.id,
      targetMessageId: targetKey.id,
      targetFromMe: targetKey.fromMe === true,
      reactorParticipant:
        typeof reactionKey.participant === "string"
          ? reactionKey.participant
          : undefined,
      action: emoji ? "added" : "removed",
      emoji: emoji || "",
      timestampMs: parseTimestamp(entry.reaction.senderTimestampMs),
    };
  } catch {
    return null;
  }
}

export function isWhatsAppReactionGroupEligible(params: {
  groupMode: WhatsAppGroupMode;
  allowedGroups?: string[];
  groupJid: string;
  targetFromMe: boolean;
}): boolean {
  const canonicalGroupJid = stripDeviceSuffix(params.groupJid);
  if (params.groupMode === "disabled") return false;
  if (
    params.allowedGroups?.length &&
    !params.allowedGroups.includes(canonicalGroupJid)
  ) {
    return false;
  }
  if (params.targetFromMe !== true) return false;
  return params.groupMode === "open" || params.groupMode === "mention";
}
