import type {
  ChannelTurnSource,
  InboundChannelMessage,
  SignalChannelAccount,
} from "@/channels/types";
import type { SignalSseEvent } from "./client";
import type {
  SignalDataMessage,
  SignalEnvelope,
  SignalReceivePayload,
  SignalSentSyncMessage,
} from "./internal-types";
import {
  buildAttachmentPlaceholder,
  resolveSignalInboundAttachments,
} from "./media";
import type { SignalMessageTarget } from "./target";
import { isSignalGroupAllowed, matchesSignalMentionPatterns } from "./target";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSignalEventData(
  event: SignalSseEvent,
): SignalReceivePayload | null {
  if (event.event && event.event !== "receive") {
    return null;
  }
  if (!event.data) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as SignalReceivePayload;
  } catch {
    return null;
  }
}

export function normalizeIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function isOwnSignalMessage(
  envelope: SignalEnvelope,
  account: SignalChannelAccount,
): boolean {
  const accountPhone = normalizeIdentity(account.account);
  const accountUuid = normalizeIdentity(account.accountUuid);
  const senderPhone = normalizeIdentity(envelope.sourceNumber);
  const senderUuid = normalizeIdentity(envelope.sourceUuid);
  return (
    (!!accountPhone && !!senderPhone && accountPhone === senderPhone) ||
    (!!accountUuid && !!senderUuid && accountUuid === senderUuid)
  );
}

export function signalIdentityMatchesAccount(
  identity: string | null | undefined,
  account: SignalChannelAccount,
): boolean {
  const normalized = normalizeIdentity(identity);
  if (!normalized) return false;
  return (
    normalized === normalizeIdentity(account.account) ||
    normalized === normalizeIdentity(account.accountUuid)
  );
}

export function normalizeSignalAliasKey(
  value: string | null | undefined,
): string {
  return (value ?? "").trim().toLowerCase();
}

export function formatSignalAdapterError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export function resolveSignalRecipientAlias(
  identity: string | null | undefined,
  account: SignalChannelAccount,
): string | null {
  const key = normalizeSignalAliasKey(identity);
  if (!key) return null;
  const aliases = account.recipientAliases ?? {};
  for (const [from, to] of Object.entries(aliases)) {
    if (normalizeSignalAliasKey(from) === key && to.trim()) {
      return to.trim();
    }
  }
  return null;
}

export function syncMessageTargetsOwnAccount(
  sentMessage: SignalSentSyncMessage,
  account: SignalChannelAccount,
): boolean {
  if (signalIdentityMatchesAccount(sentMessage.destination, account)) {
    return true;
  }
  if (signalIdentityMatchesAccount(sentMessage.destinationNumber, account)) {
    return true;
  }
  if (signalIdentityMatchesAccount(sentMessage.destinationUuid, account)) {
    return true;
  }
  return (sentMessage.recipients ?? []).some((recipient) =>
    signalIdentityMatchesAccount(recipient, account),
  );
}

export function envelopeFromSelfSyncMessage(
  envelope: SignalEnvelope,
  account: SignalChannelAccount,
): SignalEnvelope | null {
  const sentMessage = envelope.syncMessage?.sentMessage;
  if (!sentMessage || !syncMessageTargetsOwnAccount(sentMessage, account)) {
    return null;
  }
  return {
    sourceNumber: account.account ?? envelope.sourceNumber,
    sourceUuid: account.accountUuid ?? envelope.sourceUuid,
    sourceName: "Note to Self",
    timestamp: sentMessage.timestamp ?? envelope.timestamp,
    dataMessage: sentMessage,
  };
}

export function signalTargetMatchesAccount(
  target: SignalMessageTarget,
  account: SignalChannelAccount,
): boolean {
  return (
    target.kind === "recipient" &&
    signalIdentityMatchesAccount(target.recipient, account)
  );
}

export function renderSignalMentions(
  text: string,
  mentions: SignalDataMessage["mentions"],
): string {
  let mentionIndex = 0;
  return text.replace(/\uFFFC/g, () => {
    const mention = mentions?.[mentionIndex++];
    const label = mention?.name ?? mention?.number ?? mention?.uuid;
    return label ? `@${label}` : "@mention";
  });
}

export function buildSignalMessageId(
  timestamp: number | null | undefined,
  author: string,
): string {
  const resolvedTimestamp =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? String(timestamp)
      : String(Date.now());
  return `${resolvedTimestamp}:${author}`;
}

export function parseReactionTargetMessageId(messageId: string): {
  targetTimestamp: number;
  targetAuthor?: string;
} {
  const [timestampPart, ...authorParts] = messageId.split(":");
  const targetTimestamp = Number(timestampPart);
  if (!Number.isFinite(targetTimestamp)) {
    throw new Error(
      "Signal reactions require a numeric target timestamp. Use the messageId from a Signal inbound message.",
    );
  }
  const targetAuthor = authorParts.join(":").trim() || undefined;
  return { targetTimestamp, targetAuthor };
}

export function signalInboundFromPayload(
  payload: SignalReceivePayload,
  account: SignalChannelAccount,
): InboundChannelMessage | null {
  if (payload.exception?.message) {
    console.error(`[Signal] receive exception: ${payload.exception.message}`);
  }
  if (
    payload.account &&
    !signalIdentityMatchesAccount(payload.account, account)
  ) {
    return null;
  }
  let envelope = payload.envelope ?? undefined;
  if (!envelope) {
    return null;
  }
  if ("syncMessage" in envelope) {
    if (account.selfChatMode !== true) {
      return null;
    }
    envelope = envelopeFromSelfSyncMessage(envelope, account) ?? undefined;
    if (!envelope) {
      return null;
    }
  }
  const isOwnMessage = isOwnSignalMessage(envelope, account);
  if (isOwnMessage && account.selfChatMode !== true) {
    return null;
  }
  if (account.selfChatMode === true && !isOwnMessage) {
    return null;
  }

  const dataMessage =
    envelope.dataMessage ?? envelope.editMessage?.dataMessage ?? null;
  const reaction = envelope.reactionMessage ?? dataMessage?.reaction ?? null;
  const senderIdentity = envelope.sourceNumber ?? envelope.sourceUuid ?? null;
  if (!senderIdentity) {
    return null;
  }
  const replyRecipient =
    envelope.sourceNumber ??
    resolveSignalRecipientAlias(envelope.sourceUuid, account) ??
    envelope.sourceUuid ??
    null;

  const groupInfo = dataMessage?.groupInfo ?? reaction?.groupInfo ?? null;
  const groupId = groupInfo?.groupId ?? undefined;
  const isGroup = !!groupId;
  if (isGroup) {
    if ((account.groupMode ?? "disabled") === "disabled") {
      return null;
    }
    if (!isSignalGroupAllowed(account.allowedGroups, groupId)) {
      return null;
    }
  }

  const rawText = dataMessage?.message ?? "";
  const renderedText = renderSignalMentions(
    rawText,
    dataMessage?.mentions,
  ).trim();
  const attachments = dataMessage?.attachments ?? [];
  const attachmentPlaceholder = buildAttachmentPlaceholder(attachments);
  const text = renderedText || attachmentPlaceholder;
  const targetTimestamp =
    envelope.timestamp ??
    dataMessage?.timestamp ??
    reaction?.targetSentTimestamp ??
    Date.now();
  const resolvedTimestamp =
    typeof targetTimestamp === "number" ? targetTimestamp : Date.now();
  const downloadedAttachments = resolveSignalInboundAttachments(
    account,
    attachments,
    resolvedTimestamp,
  );
  const senderName = envelope.sourceName ?? senderIdentity;
  const chatId = isGroup ? `group:${groupId}` : `signal:${replyRecipient}`;
  const chatLabel = isGroup
    ? (groupInfo?.groupName ?? `Signal group ${groupId}`)
    : senderName;

  if (isGroup && (account.groupMode ?? "disabled") === "mention") {
    const isMention = matchesSignalMentionPatterns(
      text,
      account.mentionPatterns,
    );
    if (!isMention) {
      return null;
    }
  }

  if (!text && !reaction) {
    return null;
  }

  const baseMessage: InboundChannelMessage = {
    channel: "signal",
    accountId: account.accountId,
    chatId,
    chatType: isGroup ? "channel" : "direct",
    senderId: senderIdentity,
    senderName,
    chatLabel,
    text,
    timestamp: resolvedTimestamp,
    messageId: buildSignalMessageId(targetTimestamp, senderIdentity),
    threadId: null,
    isMention: isGroup
      ? matchesSignalMentionPatterns(text, account.mentionPatterns)
      : undefined,
    isOpenChannel: isGroup && (account.groupMode ?? "disabled") === "open",
    attachments:
      downloadedAttachments.length > 0 ? downloadedAttachments : undefined,
    raw: payload,
  };

  if (dataMessage?.quote) {
    baseMessage.replyContext = {
      senderId:
        dataMessage.quote.author ?? dataMessage.quote.authorUuid ?? undefined,
      senderName:
        dataMessage.quote.author ?? dataMessage.quote.authorUuid ?? undefined,
      text: dataMessage.quote.text ?? undefined,
    };
  }

  if (reaction?.emoji && reaction.targetSentTimestamp) {
    baseMessage.reaction = {
      action: reaction.isRemove ? "removed" : "added",
      emoji: reaction.emoji,
      targetMessageId: buildSignalMessageId(
        reaction.targetSentTimestamp,
        reaction.targetAuthor ?? reaction.targetAuthorUuid ?? senderIdentity,
      ),
      targetSenderId:
        reaction.targetAuthor ?? reaction.targetAuthorUuid ?? undefined,
    };
    if (!baseMessage.text) {
      baseMessage.text = `${senderName} reacted ${reaction.emoji}`;
    }
  }

  return baseMessage;
}

export function signalInboundFromSseEvent(
  event: SignalSseEvent,
  account: SignalChannelAccount,
): InboundChannelMessage | null {
  const payload = parseSignalEventData(event);
  if (!payload) {
    return null;
  }
  return signalInboundFromPayload(payload, account);
}

export function getSignalTypingKey(source: ChannelTurnSource): string | null {
  if (source.channel !== "signal" || !source.chatId?.trim()) {
    return null;
  }
  return [
    source.accountId ?? "",
    source.chatId,
    source.messageId ?? "",
    source.agentId,
    source.conversationId,
  ].join(":");
}
