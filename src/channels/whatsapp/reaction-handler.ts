import type {
  InboundChannelMessage,
  WhatsAppChannelAccount,
} from "@/channels/types";
import { resolveInboundIdentity } from "./identity";
import {
  isGroupJid,
  isSelfChat,
  isStatusOrBroadcastJid,
  isStrictPhoneJid,
  senderIdFromJid,
} from "./jid";
import type { LidStore } from "./lid-store";
import {
  isWhatsAppReactionGroupEligible,
  parseWhatsAppReactionEntry,
  type WhatsAppReaction,
} from "./reactions";

export interface WhatsAppReactionHandlerContext {
  account: WhatsAppChannelAccount;
  connectedAtMs: number;
  selfPhoneJid: string | null;
  selfLid: string | null;
  lidStore: LidStore;
  sentMessageIds: Set<string>;
  rememberSeen: (id: string) => boolean;
  applyObservedMappings: (
    mappings: Array<{ lidJid: string; phoneJid: string }>,
  ) => boolean;
  getGroupLabel: (groupJid: string) => Promise<string | undefined>;
  isTargetOwnedBySelf: (messageId: string) => boolean;
  deliver: (message: InboundChannelMessage) => Promise<void> | void;
  flushLidStoreIfDirty: () => void;
}

async function handleReactionEntry(
  context: WhatsAppReactionHandlerContext,
  parsed: WhatsAppReaction,
  raw: unknown,
): Promise<void> {
  const { account } = context;
  // Baileys may deliver reactions via a LID chat where it cannot equate
  // our PN identity, producing targetFromMe:false for our own messages.
  // isTargetOwnedBySelf also checks sentMessageIds and the store's
  // key.fromMe — but NOT mere store membership, since inbound messages
  // are stored there too.
  const targetIsOurs =
    parsed.targetFromMe === true ||
    context.isTargetOwnedBySelf(parsed.targetMessageId);
  if (!targetIsOurs) return;
  if (parsed.reactionKey.fromMe === true) return;
  if (isStatusOrBroadcastJid(parsed.chatId)) return;
  if (
    parsed.timestampMs !== undefined &&
    parsed.timestampMs < context.connectedAtMs - 1000
  ) {
    return;
  }
  if (context.sentMessageIds.has(parsed.reactionMessageId)) {
    context.sentMessageIds.delete(parsed.reactionMessageId);
    return;
  }

  const identity = resolveInboundIdentity(
    {
      selfPhoneJid: context.selfPhoneJid,
      selfLid: context.selfLid,
      remoteJid: parsed.chatId,
      participant: parsed.reactorParticipant,
    },
    context.lidStore,
  );
  if (!identity || !context.applyObservedMappings(identity.observedMappings)) {
    return;
  }
  if (
    context.rememberSeen(
      `reaction:${identity.chatId}:${parsed.reactionMessageId}`,
    )
  ) {
    return;
  }

  const selfChat = isSelfChat(
    parsed.chatId,
    context.selfPhoneJid,
    context.selfLid,
  );
  if (account.selfChatMode && !selfChat) return;

  const group = isGroupJid(identity.chatId);
  if (
    group &&
    !isWhatsAppReactionGroupEligible({
      groupMode: account.groupMode,
      allowedGroups: account.allowedGroups,
      groupJid: identity.chatId,
      targetFromMe: targetIsOurs,
    })
  ) {
    return;
  }

  const chatLabel = group
    ? await context.getGroupLabel(identity.chatId)
    : selfChat
      ? "Self (WhatsApp)"
      : identity.senderId;
  const targetSenderId = isStrictPhoneJid(context.selfPhoneJid)
    ? senderIdFromJid(context.selfPhoneJid)
    : isStrictPhoneJid(parsed.targetKey.participant)
      ? senderIdFromJid(parsed.targetKey.participant)
      : undefined;
  const actor = identity.senderId;
  const text =
    parsed.action === "added"
      ? `${actor} reacted ${parsed.emoji}`
      : `${actor} removed a reaction`;
  const inbound: InboundChannelMessage = {
    channel: "whatsapp",
    accountId: account.accountId,
    chatId: identity.chatId,
    senderId: actor,
    senderName: actor,
    chatLabel,
    text,
    timestamp: parsed.timestampMs ?? Date.now(),
    messageId: parsed.reactionMessageId,
    chatType: group ? "channel" : "direct",
    isMention: !group || account.groupMode === "mention",
    raw,
    reaction: {
      action: parsed.action,
      emoji: parsed.emoji,
      targetMessageId: parsed.targetMessageId,
      ...(targetSenderId ? { targetSenderId } : {}),
    },
  };

  try {
    await context.deliver(inbound);
  } catch (error) {
    console.error(
      `[WhatsApp:${account.accountId}] reaction delivery failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function handleWhatsAppReactionBatch(
  context: WhatsAppReactionHandlerContext,
  event: unknown,
): Promise<void> {
  try {
    if (!Array.isArray(event)) return;
    for (const raw of event) {
      try {
        const parsed = parseWhatsAppReactionEntry(raw);
        if (parsed) await handleReactionEntry(context, parsed, raw);
      } catch (error) {
        console.error(
          `[WhatsApp:${context.account.accountId}] reaction entry failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    context.flushLidStoreIfDirty();
  }
}
