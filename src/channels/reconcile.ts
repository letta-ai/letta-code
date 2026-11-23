import { getChannelAccount, loadChannelAccounts } from "./accounts";
import { isDiscordGuildChannelAllowed } from "./discord/channel-gating";
import { getRoutesForChannel, loadRoutes, removeRoute } from "./routing";
import type { ChannelRoute, DiscordChannelAccount } from "./types";

export interface StaleRouteInfo {
  route: ChannelRoute;
  reason: string;
  resolvedGateChannelId: string | null;
  canResolve: boolean;
}

export interface ReconcileOptions {
  apply?: boolean;
}

export interface ReconciliationResult {
  channel: string;
  accountId: string;
  totalRoutesChecked: number;
  staleRoutes: StaleRouteInfo[];
  removedRoutes: ChannelRoute[];
  skippedByPolicy: StaleRouteInfo[];
  policyGateReason: string | null;
}

type ChannelReconciler = (
  account: DiscordChannelAccount,
  options?: ReconcileOptions,
) => ReconciliationResult;

const CHANNEL_RECONCILERS = new Map<string, ChannelReconciler>();

export function registerReconciler(
  channel: string,
  reconciler: ChannelReconciler,
): void {
  CHANNEL_RECONCILERS.set(channel, reconciler);
}

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

function reconcileDiscord(
  account: DiscordChannelAccount,
  options?: ReconcileOptions,
): ReconciliationResult {
  const { allowedChannels, accountId, removeStaleRoutes } = account;

  loadRoutes("discord");
  const allRoutes = getRoutesForChannel("discord", accountId);

  const staleRoutes: StaleRouteInfo[] = [];
  const removedRoutes: ChannelRoute[] = [];
  const skippedByPolicy: StaleRouteInfo[] = [];

  for (const route of allRoutes) {
    if (route.chatType === "direct") {
      continue;
    }

    if (!allowedChannels) {
      continue;
    }

    if (
      (Array.isArray(allowedChannels) && allowedChannels.length === 0) ||
      (typeof allowedChannels === "object" &&
        !Array.isArray(allowedChannels) &&
        Object.keys(allowedChannels).length === 0)
    ) {
      continue;
    }

    const isThread =
      route.chatType === "channel" &&
      route.threadId !== null &&
      route.threadId !== undefined;

    if (isThread) {
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

    const channelId = route.chatId;

    const isAllowed = isDiscordGuildChannelAllowed({
      channelId,
      parentChannelId: null,
      isThread: false,
      allowedChannels,
    });

    if (!isAllowed) {
      const staleInfo: StaleRouteInfo = {
        route,
        reason: `Guild channel "${channelId}" is not in the allowed_channels list.`,
        resolvedGateChannelId: channelId,
        canResolve: true,
      };
      staleRoutes.push(staleInfo);

      if (options?.apply) {
        if (removeStaleRoutes) {
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
    options?.apply && !removeStaleRoutes && skippedByPolicy.length > 0
      ? "remove_stale_routes is false (default). " +
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

registerReconciler("discord", reconcileDiscord);
