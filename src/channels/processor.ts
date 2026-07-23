import type {
  ChannelRoute,
  ChannelThreadContext,
  ChannelThreadContextEntry,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "./types";

export interface BuildChannelTurnSourceParams {
  message: InboundChannelMessage;
  route: ChannelRoute;
}

export interface FormatInboundChannelMessageParams {
  message: InboundChannelMessage;
}

export interface ChannelBatchMessage {
  text: string;
  senderId?: string;
  senderName?: string;
  timestamp?: string | number;
  channelTurnSource?: ChannelTurnSource;
}

export interface FormatBatchedChannelMessagesParams {
  messages: ChannelBatchMessage[];
}

export interface BuildOutboundChannelMessageFromTurnSourceParams {
  turnSource: ChannelTurnSource;
  text: string;
}

function formatSenderLabel(entry: ChannelThreadContextEntry): string {
  const senderName = entry.senderName?.trim();
  const senderId = entry.senderId?.trim();
  if (senderName && senderId && senderName !== senderId) {
    return `${senderName}:${senderId}`;
  }
  if (senderName) {
    return senderName;
  }
  if (senderId) {
    return senderId;
  }
  return "unknown";
}

function formatThreadContextEntry(entry: ChannelThreadContextEntry): string {
  const messageId = entry.messageId ? `<${entry.messageId}>` : "";
  return `[${formatSenderLabel(entry)}]${messageId}:${entry.text}`;
}

function formatThreadContext(context: ChannelThreadContext): string {
  const lines: string[] = [];
  const label = context.label?.trim();
  lines.push(label ? `--- ${label} ---` : "--- Thread Context ---");
  if (context.starter) {
    lines.push(`starter: ${formatThreadContextEntry(context.starter)}`);
  }
  for (const entry of context.history ?? []) {
    lines.push(formatThreadContextEntry(entry));
  }
  lines.push("--- End Thread Context ---");
  return `${lines.join("\n")}\n\n`;
}

function formatInboundSender(message: InboundChannelMessage): string {
  const senderName = message.senderName?.trim();
  if (senderName && senderName !== message.senderId) {
    return `${senderName}:${message.senderId}`;
  }
  return message.senderId;
}

export function buildChannelTurnSource(
  params: BuildChannelTurnSourceParams,
): ChannelTurnSource {
  const { message, route } = params;
  return {
    channel: message.channel,
    accountId: message.accountId ?? route.accountId,
    chatId: message.chatId,
    chatType: message.chatType ?? route.chatType,
    senderId: message.senderId,
    senderTeamId: message.senderTeamId,
    messageId: message.messageId,
    threadId: message.threadId ?? route.threadId ?? null,
    agentId: route.agentId,
    conversationId: route.conversationId,
  };
}

export function formatInboundChannelMessageForAgent(
  params: FormatInboundChannelMessageParams,
): string {
  const { message } = params;
  const context = message.threadContext
    ? formatThreadContext(message.threadContext)
    : "";
  const chatLabel = message.chatLabel?.trim() || message.chatId;
  const timestamp = new Date(message.timestamp).toISOString();
  const prefix = `[${message.channel}:${chatLabel}][${formatInboundSender(
    message,
  )}]<${timestamp}>:`;
  return `${context}${prefix}${message.text}`;
}

function formatLegacyBatchedSender(message: ChannelBatchMessage): string {
  const senderName = message.senderName?.trim();
  const senderId = message.senderId?.trim() ?? "unknown";
  if (senderName && senderName !== senderId) {
    return `${senderName}:${senderId}`;
  }
  return senderId;
}

export function formatBatchedChannelMessagesForAgent(
  params: FormatBatchedChannelMessagesParams,
): string {
  const { messages } = params;
  if (messages.length === 0) {
    return "";
  }
  const firstMessage = messages[0];
  if (messages.length === 1 && firstMessage) {
    return firstMessage.text;
  }

  if (messages.every((message) => message.channelTurnSource)) {
    const formatted = messages.map((message) => message.text).join("\n");
    return `--- Batched Channel Messages (${messages.length}) ---\n${formatted}\n--- End Batched Channel Messages ---`;
  }

  const formatted = messages
    .map((message) => {
      const timestamp = message.timestamp ?? "unknown";
      return `[user@${formatLegacyBatchedSender(message)}]<${timestamp}>:${message.text}`;
    })
    .join("\n");

  return `--- Batched Messages (${messages.length}) ---\n${formatted}\n--- End Batched Messages ---`;
}

export function buildOutboundChannelMessageFromTurnSource(
  params: BuildOutboundChannelMessageFromTurnSourceParams,
): OutboundChannelMessage {
  const { turnSource } = params;
  return {
    channel: turnSource.channel,
    accountId: turnSource.accountId,
    chatId: turnSource.chatId,
    threadId: turnSource.threadId,
    source: turnSource,
    text: params.text,
    agentId: turnSource.agentId,
    conversationId: turnSource.conversationId,
  };
}
