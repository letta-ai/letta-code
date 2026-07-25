/**
 * Turn-scoped delivery grants for the MessageChannel tool.
 *
 * A grant is a runtime-attested ChannelTurnSource matching the executing
 * scope and requested chat. Sources are injected per-execution by the
 * runtime (manager.ts strips model-supplied values), so a matching entry
 * is an attestation that the current turn is associated with that chat —
 * an inbound message from it, or a scheduled run whose delivery target
 * was validated at creation time. This authorizes sends to chats with no
 * persisted route for the scope (e.g. a conversation created at fire
 * time by a cron task) without touching the routing table, which binds
 * each chat to exactly one conversation for inbound delivery.
 */

import { LEGACY_CHANNEL_ACCOUNT_ID } from "@/channels/accounts";
import type {
  ChannelRoute,
  ChannelTurnSource,
  SupportedChannelId,
} from "@/channels/types";

export function buildSyntheticChannelRoute(params: {
  scope: { agentId: string; conversationId: string };
  accountId: string;
  chatId: string;
  chatType?: ChannelRoute["chatType"];
  threadId?: string | null;
}): ChannelRoute {
  const now = new Date().toISOString();
  return {
    accountId: params.accountId,
    chatId: params.chatId,
    chatType: params.chatType,
    threadId: params.threadId ?? null,
    agentId: params.scope.agentId,
    conversationId: params.scope.conversationId,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Find a runtime-attested turn source for this exact scope and chat. */
export function findDeliveryGrantSource(params: {
  channel: SupportedChannelId;
  chatId: string;
  accountId?: string;
  scope: { agentId: string; conversationId: string };
  channelTurnSources?: ChannelTurnSource[];
}): ChannelTurnSource | null {
  const requestedAccountId = params.accountId?.trim();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.channel ||
      source.chatId !== params.chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId
    ) {
      continue;
    }
    if (
      requestedAccountId &&
      (source.accountId?.trim() || LEGACY_CHANNEL_ACCOUNT_ID) !==
        requestedAccountId
    ) {
      continue;
    }
    return source;
  }
  return null;
}

/**
 * Build a synthetic route from a matching grant, or null when no
 * runtime-attested source covers the requested chat.
 */
export function resolveGrantChannelRoute(params: {
  channel: SupportedChannelId;
  chatId: string;
  accountId?: string;
  scope: { agentId: string; conversationId: string };
  channelTurnSources?: ChannelTurnSource[];
}): ChannelRoute | null {
  const grant = findDeliveryGrantSource(params);
  if (!grant) {
    return null;
  }
  return buildSyntheticChannelRoute({
    scope: params.scope,
    accountId: grant.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    chatId: params.chatId,
    chatType: grant.chatType,
    threadId: grant.threadId ?? null,
  });
}
