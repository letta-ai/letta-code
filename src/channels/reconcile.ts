/**
 * Channel route reconciliation — detect stale/disallowed routes that
 * violate the current allowed_channels policy.
 *
 * Extensible pattern: `reconcileRoutesForChannel()` dispatches to a
 * channel-specific handler. Discord is implemented first; other channels
 * can add handlers via the `CHANNEL_RECONCILERS` registry.
 *
 * Reconciliation checks:
 *   1. DM routes (chatType === "direct") — always allowed, skipped.
 *   2. Guild channel routes (chatType === "channel", no threadId) —
 *      checked directly against allowedChannels.
 *   3. Thread routes (chatType === "channel", threadId is set) —
 *      parent channel ID is not stored in routes, so the reconciler
 *      reports them as "indeterminate" and skips them.
 *
 * CLI invocation:
 *   letta channels route reconcile --channel discord [--account-id ...] [--apply]
 *
 *   --apply with removeStaleConversations=false (the default): route removal is
 *   blocked and a clear diagnostic is emitted.
 *   --apply with removeStaleConversations=true: stale routes are removed.
 */

import { getChannelAccount, loadChannelAccounts } from "./accounts";
import { getRoutesForChannel, loadRoutes, removeRoute } from "./routing";
import type { ChannelRoute, DiscordChannelAccount } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export interface StaleRouteInfo {
  /** The route that violates current policy. */
  route: ChannelRoute;
  /** Human-readable explanation of why it's stale. */
  reason: string;
  /** The channel ID that was checked against allowedChannels. */
  resolvedGateChannelId: string | null;
  /**
   * false when we cannot determine the gate channel (e.g. thread routes
   * whose parent channel ID is not stored).
   */
  canResolve: boolean;
}

export interface ReconcileOptions {
  /** When true, apply destructive changes (remove stale routes). */
  apply?: boolean;
}

export interface ReconciliationResult {
  /** Channel this reconciliation targeted. */
  channel: string;
  /** Account ID that was reconciled. */
  accountId: string;
  /** Total routes examined. */
  totalRoutesChecked: number;
  /** Routes that violate current allowed_channels policy. */
  staleRoutes: StaleRouteInfo[];
  /** Routes that were actually removed (only when --apply and policy allows). */
  removedRoutes: ChannelRoute[];
  /** Routes that would be removed but were blocked by policy. */
  skippedByPolicy: StaleRouteInfo[];
  /** Human-readable explanation of why removal was skipped/policy-blocked. */
  policyGateReason: string | null;
}

// ── Reconciler registry ────────────────────────────────────────────

type ChannelReconciler = (
  account: DiscordChannelAccount,
  options?: ReconcileOptions,
) => ReconciliationResult;

const CHANNEL_RECONCILERS = new Map<string, ChannelReconciler>();

/**
 * Register a channel reconciler. Each channel registers its own handler.
 */
export function registerReconciler(
  channel: string,
  reconciler: ChannelReconciler,
): void {
  CHANNEL_RECONCILERS.set(channel, reconciler);
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Run route reconciliation for a specific channel+account.
 *
 * @returns The reconciliation result or an error result.
 */
export function reconcileRoutesForChannel(
  channel: string,
  accountId: string,
  options?: ReconcileOptions,
): ReconciliationResult {
  loadChannelAccounts(channel);
  loadRoutes(channel);

  const account = getChannelAccount(channel, accountId);
  if (!account) {
    return {
      channel,
      accountId,
      totalRoutesChecked: 0,
      staleRoutes: [],
      removedRoutes: [],
      skippedByPolicy: [],
      policyGateReason: `Account "${accountId}" not found for channel "${channel}".`,
    };
  }

  // Look up the channel-specific reconciler
  const reconciler = CHANNEL_RECONCILERS.get(channel);
  if (reconciler) {
    return reconciler(account as DiscordChannelAccount, options);
  }

  return {
    channel,
    accountId,
    totalRoutesChecked: 0,
    staleRoutes: [],
    removedRoutes: [],
    skippedByPolicy: [],
    policyGateReason: `No reconciler registered for channel "${channel}".`,
  };
}

// ── Discord reconciler ─────────────────────────────────────────────

function reconcileDiscord(
  account: DiscordChannelAccount,
  options?: ReconcileOptions,
): ReconciliationResult {
  const { allowedChannels, accountId, removeStaleConversations } = account;

  // Load routes from disk
  loadRoutes("discord");
  const allRoutes = getRoutesForChannel("discord", accountId);

  const staleRoutes: StaleRouteInfo[] = [];
  const removedRoutes: ChannelRoute[] = [];
  const skippedByPolicy: StaleRouteInfo[] = [];

  for (const route of allRoutes) {
    // Skip DM routes — DMs are never gated by allowedChannels
    if (route.chatType === "direct") {
      continue;
    }

    // If no allowedChannels is configured, no routes are stale
    if (!allowedChannels) {
      continue;
    }

    // Empty allowlist means "all channels allowed" — nothing is stale
    if (
      (Array.isArray(allowedChannels) && allowedChannels.length === 0) ||
      (typeof allowedChannels === "object" &&
        !Array.isArray(allowedChannels) &&
        Object.keys(allowedChannels).length === 0)
    ) {
      continue;
    }

    // This route is a guild channel route
    const isThread =
      route.chatType === "channel" &&
      route.threadId !== null &&
      route.threadId !== undefined;

    if (isThread) {
      // Thread routes: we don't store parentChannelId, so we can't
      // determine the gate channel. Report as indeterminate.
      staleRoutes.push({
        route,
        reason:
          "Thread route — parent channel ID is not stored in the route. " +
          "Cannot determine whether the parent channel is still allowed. " +
          "Manual inspection required.",
        resolvedGateChannelId: null,
        canResolve: false,
      });
      continue;
    }

    // Non-thread guild channel route — chatId IS the guild channel
    const channelId = route.chatId;

    // Check if this channel is in the allowedChannels list
    let isAllowed: boolean;
    if (Array.isArray(allowedChannels)) {
      isAllowed = allowedChannels.includes(channelId);
    } else {
      // Mode map
      isAllowed = channelId in allowedChannels;
    }

    if (!isAllowed) {
      const staleInfo: StaleRouteInfo = {
        route,
        reason: `Guild channel "${channelId}" is not in the allowed_channels list.`,
        resolvedGateChannelId: channelId,
        canResolve: true,
      };
      staleRoutes.push(staleInfo);

      // Apply phase
      if (options?.apply) {
        if (removeStaleConversations) {
          const removed = removeRoute(
            "discord",
            route.chatId,
            route.accountId,
            route.threadId,
          );
          if (removed) {
            removedRoutes.push(route);
          }
        } else {
          skippedByPolicy.push(staleInfo);
        }
      }
    }
  }

  const policyGateReason =
    options?.apply && !removeStaleConversations && skippedByPolicy.length > 0
      ? "remove_stale_conversations is false (default). " +
        "Set it to true in the Discord account config to allow --apply removals. " +
        `${skippedByPolicy.length} stale route(s) would be removed but were blocked by policy.`
      : null;

  return {
    channel: "discord",
    accountId,
    totalRoutesChecked: allRoutes.length,
    staleRoutes,
    removedRoutes,
    skippedByPolicy,
    policyGateReason,
  };
}

// ── Register the Discord reconciler ────────────────────────────────

registerReconciler("discord", reconcileDiscord);
