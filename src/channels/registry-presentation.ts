import {
  getChannelDisplayName,
  isFirstPartyChannelPlugin,
} from "./plugin-registry";
import type {
  ChannelRoute,
  ChannelTurnSource,
  InboundChannelMessage,
} from "./types";

type PairingInstructionOptions = {
  agentId?: string | null;
};

type AccountAgentIdSource = {
  agentId?: string | null;
  binding?: {
    agentId?: string | null;
  };
};

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const normalized = agentId?.trim();
  return normalized ? normalized : null;
}

export function getConfiguredAgentId(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const source = config as AccountAgentIdSource;
  return (
    normalizeAgentId(source.agentId) ??
    normalizeAgentId(source.binding?.agentId)
  );
}

export function buildPairingInstructions(
  channelId: string,
  code: string,
  options: PairingInstructionOptions = {},
): string {
  const displayName = channelDisplayName(channelId);
  const configuredAgentId = normalizeAgentId(options.agentId);
  const pairingCommand = `letta channels pair --channel ${channelId} --code ${code} --agent ${configuredAgentId ?? "<agent-id>"}`;
  const agentLookupLines = configuredAgentId
    ? []
    : ["Find the target agent with: letta agents list"];
  if (!isFirstPartyChannelPlugin(channelId)) {
    return [
      "Connect this chat to a Letta agent.",
      "",
      `Pairing code: ${code}`,
      "",
      "CLI on the listener machine:",
      pairingCommand,
      ...agentLookupLines,
      "",
      "This code expires 15 minutes after it was first issued.",
    ].join("\n");
  }
  return [
    "Connect this chat to a Letta agent.",
    "",
    `Pairing code: ${code}`,
    "",
    `In Letta Code: open Channels > ${displayName} and approve this pending chat.`,
    "",
    "CLI on the listener machine:",
    pairingCommand,
    ...agentLookupLines,
    "",
    "This code expires 15 minutes after it was first issued.",
  ].join("\n");
}

export function buildUnboundRouteInstructions(
  channelId: string,
  chatId: string,
): string {
  const displayName = channelDisplayName(channelId);
  if (!isFirstPartyChannelPlugin(channelId)) {
    return (
      `This chat isn't connected to a Letta agent yet.\n\n` +
      `On the machine where your listener runs:\n\n` +
      `letta channels route add --channel ${channelId} --chat-id ${chatId} --agent <agent-id>\n\n` +
      `Find your agent id with letta agents list.`
    );
  }
  return (
    `This chat isn't connected to a Letta agent yet.\n\n` +
    `Open Channels > ${displayName} in Letta Code and connect this chat there.\n\n` +
    `Chat ID: ${chatId}`
  );
}

export function buildSlackAppSetupInstructions(): string {
  return (
    "This Slack app isn't connected to a Letta agent yet.\n\n" +
    "Open Channels > Slack in Letta Code, choose which agent this app should represent, and try again."
  );
}

function truncateChannelSummaryPreview(
  text: string,
  maxLength = 72,
): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildSlackConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    | "chatId"
    | "chatLabel"
    | "chatType"
    | "senderId"
    | "senderName"
    | "text"
    | "threadId"
  >,
): string {
  if (msg.chatType === "direct") {
    if (msg.threadId?.trim()) {
      const preview = truncateChannelSummaryPreview(msg.text);
      return preview
        ? `[Slack] DM thread with ${msg.senderName?.trim() || msg.senderId}: ${preview}`
        : `[Slack] DM thread with ${msg.senderName?.trim() || msg.senderId}`;
    }
    return `[Slack] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }

  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";
  if (preview) return `[Slack] Thread${channelLabel}: ${preview}`;
  return `[Slack] Thread${channelLabel || ` ${msg.chatId}`}`;
}

export function buildDiscordConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Discord] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }
  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";
  if (preview) return `[Discord] Thread${channelLabel}: ${preview}`;
  return `[Discord] Thread${channelLabel || ` ${msg.chatId}`}`;
}

export function buildTelegramConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Telegram] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }
  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";
  if (preview) return `[Telegram] Topic${channelLabel}: ${preview}`;
  return `[Telegram] Topic${channelLabel || ` ${msg.chatId}`}`;
}

export function buildWhatsAppConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[WhatsApp] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }
  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";
  if (preview) return `[WhatsApp] Group${channelLabel}: ${preview}`;
  return `[WhatsApp] Group${channelLabel || ` ${msg.chatId}`}`;
}

export function buildSignalConversationSummary(
  msg: Pick<
    InboundChannelMessage,
    "chatId" | "chatLabel" | "chatType" | "senderId" | "senderName" | "text"
  >,
): string {
  if (msg.chatType === "direct") {
    return `[Signal] DM with ${msg.senderName?.trim() || msg.senderId}`;
  }
  const preview = truncateChannelSummaryPreview(msg.text);
  const channelLabel =
    msg.chatLabel && msg.chatLabel !== msg.chatId ? ` in ${msg.chatLabel}` : "";
  if (preview) return `[Signal] Group${channelLabel}: ${preview}`;
  return `[Signal] Group${channelLabel || ` ${msg.chatId}`}`;
}

export function buildChannelTurnSource(
  route: ChannelRoute,
  msg: Pick<
    InboundChannelMessage,
    | "channel"
    | "accountId"
    | "chatId"
    | "chatType"
    | "senderId"
    | "senderTeamId"
    | "messageId"
    | "threadId"
  >,
): ChannelTurnSource {
  return {
    channel: msg.channel as ChannelTurnSource["channel"],
    accountId: msg.accountId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    senderTeamId: msg.senderTeamId,
    messageId: msg.messageId,
    threadId: msg.threadId,
    agentId: route.agentId,
    conversationId: route.conversationId,
  };
}

export function buildDirectReplyOptions(
  msg: Pick<InboundChannelMessage, "messageId" | "threadId">,
): { replyToMessageId?: string; threadId?: string | null } | undefined {
  if (!msg.messageId && !msg.threadId) return undefined;
  return {
    replyToMessageId: msg.threadId ?? msg.messageId ?? undefined,
    threadId: msg.threadId ?? null,
  };
}
