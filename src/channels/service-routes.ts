import {
  getChannelAccount,
  LEGACY_CHANNEL_ACCOUNT_ID,
  upsertChannelAccount,
} from "./accounts";
import { getPendingPairings, loadPairingStore } from "./pairing";
import { completePairing } from "./registry";
import {
  addRoute,
  getRoute,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
  removeRouteInMemory,
  setRouteInMemory,
} from "./routing";
import {
  assertSupportedChannelId,
  getErrorMessage,
  getSelectedChannelAccount,
} from "./service-shared";
import type {
  ChannelRouteSnapshot,
  ChannelTargetSnapshot,
  PendingPairingSnapshot,
} from "./service-types";
import {
  listChannelTargets,
  loadTargetStore,
  removeChannelTarget,
  upsertChannelTarget,
} from "./targets";
import type {
  ChannelBindableTarget,
  ChannelRoute,
  PendingPairing,
} from "./types";
import { isTelegramChannelAccount } from "./types";

function getSelectedRouteByChatId(
  channelId: string,
  chatId: string,
  accountId?: string,
): ChannelRoute | null {
  const matches = getRoutesForChannel(channelId, accountId).filter(
    (route) => route.chatId === chatId,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  throw new Error(
    `Channel "${channelId}" has multiple routes for chat "${chatId}". Specify account_id.`,
  );
}

function getSelectedTargetById(
  channelId: string,
  targetId: string,
  accountId?: string,
): ChannelBindableTarget | null {
  const matches = listChannelTargets(channelId, accountId).filter(
    (target) => target.targetId === targetId,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  throw new Error(
    `Channel "${channelId}" has multiple targets named "${targetId}". Specify account_id.`,
  );
}

function toPendingPairingSnapshot(
  pending: Pick<
    PendingPairing,
    | "accountId"
    | "code"
    | "senderId"
    | "senderName"
    | "chatId"
    | "createdAt"
    | "expiresAt"
  >,
): PendingPairingSnapshot {
  return {
    accountId: pending.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    code: pending.code,
    senderId: pending.senderId,
    senderName: pending.senderName,
    chatId: pending.chatId,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

function toRouteSnapshot(
  channelId: string,
  route: ChannelRoute,
): ChannelRouteSnapshot {
  return {
    channelId,
    accountId: route.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    chatId: route.chatId,
    chatType: route.chatType,
    threadId: route.threadId ?? null,
    agentId: route.agentId,
    conversationId: route.conversationId,
    enabled: route.enabled,
    outboundEnabled: route.outboundEnabled !== false,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt ?? route.createdAt,
  };
}

function toTargetSnapshot(
  channelId: string,
  target: ChannelBindableTarget,
): ChannelTargetSnapshot {
  return {
    channelId,
    accountId: target.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    targetId: target.targetId,
    targetType: target.targetType,
    chatId: target.chatId,
    label: target.label,
    discoveredAt: target.discoveredAt,
    lastSeenAt: target.lastSeenAt,
    lastMessageId: target.lastMessageId,
  };
}

export function listPendingPairingSnapshots(
  channelId: string,
  accountId?: string,
): PendingPairingSnapshot[] {
  assertSupportedChannelId(channelId);
  loadPairingStore(channelId);
  return getPendingPairings(channelId, accountId).map(toPendingPairingSnapshot);
}

export function bindChannelPairing(
  channelId: string,
  code: string,
  agentId: string,
  conversationId: string,
  accountId?: string,
): { chatId: string; route: ChannelRouteSnapshot } {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);
  loadPairingStore(channelId);

  const result = completePairing(
    channelId,
    code,
    agentId,
    conversationId,
    accountId,
  );
  if (!result.success || !result.chatId) {
    throw new Error(result.error ?? "Failed to bind pairing");
  }

  const route = getRoute(channelId, result.chatId, result.accountId);
  if (!route) {
    throw new Error("Pairing succeeded but route was not found");
  }

  return {
    chatId: result.chatId,
    route: toRouteSnapshot(channelId, route),
  };
}

export function listChannelTargetSnapshots(
  channelId: string,
  accountId?: string,
): ChannelTargetSnapshot[] {
  assertSupportedChannelId(channelId);
  loadTargetStore(channelId);
  return listChannelTargets(channelId, accountId).map((target) =>
    toTargetSnapshot(channelId, target),
  );
}

export function bindChannelTarget(
  channelId: string,
  targetId: string,
  agentId: string,
  conversationId: string,
  accountId?: string,
): { chatId: string; route: ChannelRouteSnapshot } {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);
  loadTargetStore(channelId);

  const target = getSelectedTargetById(channelId, targetId, accountId);
  if (!target) {
    throw new Error(`Unknown channel target: ${targetId}`);
  }

  const route: ChannelRoute = {
    accountId: target.accountId,
    chatId: target.chatId,
    chatType: "channel",
    threadId: null,
    agentId,
    conversationId,
    enabled: true,
    outboundEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    removeChannelTarget(channelId, targetId, target.accountId);
  } catch (error) {
    try {
      upsertChannelTarget(channelId, target);
    } catch (rollbackError) {
      throw new Error(
        `Failed to bind channel target: ${getErrorMessage(
          error,
          "Failed to remove pending target",
        )}. Failed to restore pending target: ${getErrorMessage(
          rollbackError,
          "Target rollback failed",
        )}`,
      );
    }
    throw new Error(
      `Failed to bind channel target: ${getErrorMessage(
        error,
        "Failed to remove pending target",
      )}`,
    );
  }

  try {
    addRoute(channelId, route);
  } catch (error) {
    removeRouteInMemory(
      channelId,
      route.chatId,
      route.accountId,
      route.threadId,
    );
    try {
      upsertChannelTarget(channelId, target);
    } catch (rollbackError) {
      throw new Error(
        `Failed to bind channel target: ${getErrorMessage(
          error,
          "Failed to create route",
        )}. Failed to restore pending target: ${getErrorMessage(
          rollbackError,
          "Target rollback failed",
        )}`,
      );
    }
    throw new Error(
      `Failed to bind channel target: ${getErrorMessage(
        error,
        "Failed to create route",
      )}. Changes were rolled back.`,
    );
  }

  return {
    chatId: route.chatId,
    route: toRouteSnapshot(channelId, route),
  };
}

export function updateChannelRouteLive(
  channelId: string,
  chatId: string,
  agentId: string,
  conversationId: string,
  accountId?: string,
): ChannelRouteSnapshot {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);

  const existingRoute = getSelectedRouteByChatId(channelId, chatId, accountId);
  const selectedAccount = existingRoute
    ? null
    : getSelectedChannelAccount(channelId, accountId);
  if (!existingRoute && !selectedAccount) {
    throw new Error(
      accountId
        ? `Channel account "${accountId}" was not found for ${channelId}.`
        : `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }

  const resolvedAccountId =
    existingRoute?.accountId ?? selectedAccount?.accountId ?? accountId;
  const existingAccount = resolvedAccountId
    ? getChannelAccount(channelId, resolvedAccountId)
    : null;

  if (!existingRoute && !existingAccount) {
    throw new Error(
      `Channel account "${resolvedAccountId}" was not found for ${channelId}.`,
    );
  }

  if (existingAccount && isTelegramChannelAccount(existingAccount)) {
    upsertChannelAccount(channelId, {
      ...existingAccount,
      binding: {
        agentId,
        conversationId,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  const updatedRoute: ChannelRoute = {
    ...(existingRoute ?? {
      accountId: resolvedAccountId,
      chatId,
      enabled: true,
      createdAt: new Date().toISOString(),
    }),
    agentId,
    conversationId,
    outboundEnabled: existingRoute?.outboundEnabled ?? true,
    updatedAt: new Date().toISOString(),
  };

  try {
    addRoute(channelId, updatedRoute);
  } catch (error) {
    removeRouteInMemory(
      channelId,
      chatId,
      resolvedAccountId,
      existingRoute?.threadId,
    );
    if (existingRoute) {
      setRouteInMemory(channelId, existingRoute);
    }

    if (existingAccount && isTelegramChannelAccount(existingAccount)) {
      try {
        upsertChannelAccount(channelId, existingAccount);
      } catch (rollbackError) {
        throw new Error(
          `Failed to update channel route: ${getErrorMessage(
            error,
            "Failed to save route",
          )}. Failed to restore account binding: ${getErrorMessage(
            rollbackError,
            "Account rollback failed",
          )}`,
        );
      }
    }

    throw new Error(
      `Failed to update channel route: ${getErrorMessage(
        error,
        "Failed to save route",
      )}. Changes were rolled back.`,
    );
  }

  return toRouteSnapshot(channelId, updatedRoute);
}

export function listChannelRouteSnapshots(params?: {
  channelId?: string;
  accountId?: string;
  agentId?: string;
  conversationId?: string;
}): ChannelRouteSnapshot[] {
  const channelId = (params?.channelId ?? "telegram") as string;
  assertSupportedChannelId(channelId);

  loadRoutes(channelId);

  return getRoutesForChannel(channelId, params?.accountId)
    .filter((route) =>
      params?.agentId ? route.agentId === params.agentId : true,
    )
    .filter((route) =>
      params?.conversationId
        ? route.conversationId === params.conversationId
        : true,
    )
    .map((route) => toRouteSnapshot(channelId, route));
}

export function removeChannelRouteLive(
  channelId: string,
  chatId: string,
  accountId?: string,
): boolean {
  assertSupportedChannelId(channelId);
  loadRoutes(channelId);
  const route = getSelectedRouteByChatId(channelId, chatId, accountId);
  if (!route) {
    return false;
  }
  return removeRoute(channelId, chatId, route.accountId, route.threadId);
}
