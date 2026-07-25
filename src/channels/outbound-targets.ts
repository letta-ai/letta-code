/**
 * Outbound delivery target discovery and resolution.
 *
 * A delivery target is a chat the MessageChannel tool is allowed to send
 * to. Targets are derived from the persisted routing table (never from
 * adapter state), joined with the discovered-target store for
 * human-readable labels.
 *
 * Used by the cron delivery feature (`letta cron add --deliver`) and the
 * `letta channels targets` CLI listing.
 */

import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { getRoutesForChannel, loadRoutes } from "./routing";
import { listChannelTargets, loadTargetStore } from "./targets";
import type { ChannelChatType } from "./types";
import { SUPPORTED_CHANNEL_IDS } from "./types";

export interface OutboundDeliveryTarget {
  channel: string;
  chatId: string;
  accountId?: string;
  threadId: string | null;
  chatType?: ChannelChatType;
  /** Human-readable name when discovered; falls back to the chat id. */
  label: string;
  /** Conversation the underlying route is bound to. */
  conversationId: string;
}

function normalizeAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : LEGACY_CHANNEL_ACCOUNT_ID;
}

/**
 * List every chat the given agent may send outbound messages to,
 * optionally narrowed to one conversation and/or one channel.
 *
 * Mirrors the eligibility predicate MessageChannel enforces at send time:
 * route enabled, outbound enabled, agent (and optionally conversation)
 * match.
 */
export function listOutboundDeliveryTargets(params: {
  agentId: string;
  conversationId?: string;
  channel?: string;
}): OutboundDeliveryTarget[] {
  const channels = params.channel ? [params.channel] : SUPPORTED_CHANNEL_IDS;
  const results: OutboundDeliveryTarget[] = [];

  for (const channel of channels) {
    loadRoutes(channel);
    loadTargetStore(channel);
    const targets = listChannelTargets(channel);

    for (const route of getRoutesForChannel(channel)) {
      if (
        route.agentId !== params.agentId ||
        !route.enabled ||
        route.outboundEnabled === false
      ) {
        continue;
      }
      if (
        params.conversationId !== undefined &&
        route.conversationId !== params.conversationId
      ) {
        continue;
      }

      const label = targets.find(
        (target) =>
          target.chatId === route.chatId &&
          normalizeAccountId(target.accountId) ===
            normalizeAccountId(route.accountId),
      )?.label;

      results.push({
        channel,
        chatId: route.chatId,
        accountId: route.accountId,
        threadId: route.threadId ?? null,
        chatType: route.chatType,
        label: label ?? route.chatId,
        conversationId: route.conversationId,
      });
    }
  }

  return results;
}

export interface ResolvedDeliveryTarget {
  channel: string;
  chatId: string;
  accountId?: string;
  threadId: string | null;
  chatType?: ChannelChatType;
  label: string;
}

/**
 * Resolve a requested delivery destination against the agent's routes.
 *
 * Validation is agent-level (any conversation): the schedule authorizes
 * delivery to a chat the agent is already routed to, and the runtime
 * re-attests the grant on each fire via channelTurnSources. Returns an
 * error string (matching the channel helpers' convention) when the chat
 * is not routed to the agent or the account is ambiguous.
 */
export function resolveAgentDeliveryTarget(params: {
  agentId: string;
  channel: string;
  chatId: string;
  accountId?: string;
}): ResolvedDeliveryTarget | string {
  const candidates = listOutboundDeliveryTargets({
    agentId: params.agentId,
    channel: params.channel,
  }).filter((target) => target.chatId === params.chatId);

  const requestedAccountId = params.accountId?.trim();
  const matched = requestedAccountId
    ? candidates.filter(
        (target) =>
          normalizeAccountId(target.accountId) ===
          normalizeAccountId(requestedAccountId),
      )
    : candidates;

  if (matched.length === 0) {
    return requestedAccountId
      ? `Error: No outbound route for chat "${params.chatId}" on "${params.channel}" account "${requestedAccountId}" for this agent.`
      : `Error: No outbound route for chat "${params.chatId}" on "${params.channel}" for this agent. Run \`letta channels targets --agent <id>\` to list valid targets.`;
  }

  const accountIds = new Set(
    matched.map((target) => normalizeAccountId(target.accountId)),
  );
  if (accountIds.size > 1) {
    return `Error: Multiple accounts can deliver to chat "${params.chatId}" on "${params.channel}". Pass an account id to disambiguate.`;
  }

  const target = matched[0] as OutboundDeliveryTarget;
  return {
    channel: target.channel,
    chatId: target.chatId,
    accountId: target.accountId,
    threadId: target.threadId,
    chatType: target.chatType,
    label: target.label,
  };
}
