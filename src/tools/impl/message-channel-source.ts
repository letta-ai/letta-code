import type { ChannelMessageActionRequest } from "@/channels/plugin-types";
import {
  channelTurnSourceIdentity,
  effectiveChannelTurnSourceThreadId,
} from "@/channels/turn-source";
import type { ChannelTurnSource } from "@/channels/types";
import type { NormalizedMessageChannelInput } from "./message-channel-types";

type MessageChannelScope = { agentId: string; conversationId: string };

export function buildMessageChannelRequest(
  input: NormalizedMessageChannelInput,
  chatId: string,
  threadId?: string | null,
): ChannelMessageActionRequest {
  return {
    action: input.action,
    channel: input.channel,
    chatId,
    message: input.message,
    replyToMessageId: input.replyToMessageId,
    threadId: threadId ?? input.threadId ?? null,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    emoji: input.emoji,
    remove: input.remove,
    mediaPath: input.mediaPath,
    filename: input.filename,
    title: input.title,
  };
}

function sourceMatchesRoute(params: {
  source: ChannelTurnSource;
  input: NormalizedMessageChannelInput;
  scope: MessageChannelScope;
  accountId?: string;
  threadId?: string | null;
  /** Compare against channel routing fallbacks after thread inference. */
  useEffectiveThreadId?: boolean;
}): boolean {
  const { source, input, scope } = params;
  const sourceThreadId = params.useEffectiveThreadId
    ? effectiveChannelTurnSourceThreadId(source)
    : (source.threadId ?? null);
  return (
    source.channel === input.channel &&
    source.chatId === input.chatId &&
    source.agentId === scope.agentId &&
    source.conversationId === scope.conversationId &&
    (!params.accountId || source.accountId === params.accountId) &&
    (params.threadId === undefined ||
      sourceThreadId === (params.threadId ?? null))
  );
}

/**
 * Resolve provenance only when one distinct channel source matches the selected
 * route. Duplicate copies collapse; conflicting sources fail closed.
 */
export function resolveUniqueChannelTurnSource(params: {
  input: NormalizedMessageChannelInput;
  scope: MessageChannelScope;
  accountId?: string;
  threadId?: string | null;
  /** Compare against channel routing fallbacks after thread inference. */
  useEffectiveThreadId?: boolean;
  channelTurnSources?: ChannelTurnSource[];
}): ChannelTurnSource | undefined {
  if (!params.input.chatId) {
    return undefined;
  }

  const matchingSources = new Map<string, ChannelTurnSource>();
  for (const source of params.channelTurnSources ?? []) {
    if (!sourceMatchesRoute({ ...params, source })) {
      continue;
    }
    matchingSources.set(channelTurnSourceIdentity(source), source);
    if (matchingSources.size > 1) {
      return undefined;
    }
  }
  return matchingSources.values().next().value;
}

export function inferAccountIdFromChannelTurnSources(params: {
  input: NormalizedMessageChannelInput;
  scope: MessageChannelScope;
  channelTurnSources?: ChannelTurnSource[];
}): string | undefined {
  const chatId = params.input.chatId;
  if (!chatId) {
    return undefined;
  }

  const accountIds = new Set<string>();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.input.channel ||
      source.chatId !== chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId
    ) {
      continue;
    }
    if (
      params.input.threadId !== undefined &&
      (source.threadId ?? null) !== (params.input.threadId ?? null)
    ) {
      continue;
    }
    if (source.accountId?.trim()) {
      accountIds.add(source.accountId.trim());
    }
  }

  return accountIds.size === 1 ? [...accountIds][0] : undefined;
}

export function inferThreadIdFromChannelTurnSources(params: {
  input: NormalizedMessageChannelInput;
  scope: MessageChannelScope;
  accountId?: string;
  channelTurnSources?: ChannelTurnSource[];
}): string | null | undefined {
  if (!params.input.chatId || params.input.threadId !== null) {
    return undefined;
  }

  const threadIds = new Set<string | null>();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.input.channel ||
      source.chatId !== params.input.chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId
    ) {
      continue;
    }
    if (params.accountId && source.accountId !== params.accountId) {
      continue;
    }
    threadIds.add(effectiveChannelTurnSourceThreadId(source));
  }

  return threadIds.size === 1 ? [...threadIds][0] : undefined;
}

export function resolveMessageChannelTurnSource(params: {
  input: NormalizedMessageChannelInput;
  scope: MessageChannelScope;
  accountId?: string;
  routeThreadId?: string | null;
  channelTurnSources?: ChannelTurnSource[];
}): { threadId?: string | null; source?: ChannelTurnSource } {
  const inferredThreadId = inferThreadIdFromChannelTurnSources(params);
  const threadId =
    params.input.action === "download-file"
      ? params.input.threadId
      : (inferredThreadId ?? params.routeThreadId ?? params.input.threadId);
  const source = resolveUniqueChannelTurnSource({
    ...params,
    threadId,
    useEffectiveThreadId: true,
  });
  return { threadId, ...(source ? { source } : {}) };
}
