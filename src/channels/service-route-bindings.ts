import {
  getChannelAccount,
  LEGACY_CHANNEL_ACCOUNT_ID,
  upsertChannelAccount,
} from "./accounts";
import {
  addRoute,
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
import type { ChannelRouteSnapshot } from "./service-types";
import type { ChannelAccount, ChannelRoute } from "./types";
import { isTelegramChannelAccount } from "./types";

export interface ChannelRouteBindingTarget {
  channelId: string;
  chatId: string;
  accountId?: string;
  threadId?: string | null;
}

interface PreparedRouteBinding {
  target: ChannelRouteBindingTarget;
  resolvedAccountId?: string;
  existingRoute: ChannelRoute | null;
  existingAccount: ChannelAccount | null;
}

function getSelectedRouteByChatId(
  channelId: string,
  chatId: string,
  accountId?: string,
  threadId?: string | null,
): ChannelRoute | null {
  const matches = getRoutesForChannel(channelId, accountId).filter(
    (route) =>
      route.chatId === chatId &&
      (threadId === undefined
        ? true
        : (route.threadId ?? null) === (threadId ?? null)),
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

function cloneRoute(route: ChannelRoute): ChannelRoute {
  return { ...route };
}

function cloneChannelAccount(account: ChannelAccount): ChannelAccount {
  return structuredClone(account);
}

function routeBindingKey(binding: PreparedRouteBinding): string {
  const threadId =
    binding.target.threadId === undefined
      ? (binding.existingRoute?.threadId ?? "__root__")
      : (binding.target.threadId ?? "__root__");
  return [
    binding.target.channelId,
    binding.resolvedAccountId ?? "",
    binding.target.chatId,
    threadId,
  ].join("\0");
}

function prepareRouteBinding(
  target: ChannelRouteBindingTarget,
): PreparedRouteBinding {
  assertSupportedChannelId(target.channelId);
  loadRoutes(target.channelId);

  const existingRoute = getSelectedRouteByChatId(
    target.channelId,
    target.chatId,
    target.accountId,
    target.threadId,
  );
  const selectedAccount = existingRoute
    ? null
    : getSelectedChannelAccount(target.channelId, target.accountId);
  if (!existingRoute && !selectedAccount) {
    throw new Error(
      target.accountId
        ? `Channel account "${target.accountId}" was not found for ${target.channelId}.`
        : `Channel "${target.channelId}" is not configured. Configure it first.`,
    );
  }

  const resolvedAccountId =
    existingRoute?.accountId ?? selectedAccount?.accountId ?? target.accountId;
  const existingAccount = resolvedAccountId
    ? getChannelAccount(target.channelId, resolvedAccountId)
    : null;

  if (!existingRoute && !existingAccount) {
    throw new Error(
      `Channel account "${resolvedAccountId}" was not found for ${target.channelId}.`,
    );
  }

  return {
    target,
    resolvedAccountId,
    existingRoute: existingRoute ? cloneRoute(existingRoute) : null,
    existingAccount: existingAccount
      ? cloneChannelAccount(existingAccount)
      : null,
  };
}

function restoreAppliedRouteBindings(
  applied: PreparedRouteBinding[],
): string[] {
  const rollbackErrors: string[] = [];

  for (const binding of applied.toReversed()) {
    const { target, resolvedAccountId, existingRoute, existingAccount } =
      binding;
    try {
      if (existingRoute) {
        addRoute(target.channelId, existingRoute);
      } else {
        removeRoute(
          target.channelId,
          target.chatId,
          resolvedAccountId,
          target.threadId ?? null,
        );
      }
    } catch (rollbackError) {
      rollbackErrors.push(
        getErrorMessage(rollbackError, "Route rollback failed"),
      );
    }

    if (existingAccount && isTelegramChannelAccount(existingAccount)) {
      try {
        upsertChannelAccount(target.channelId, existingAccount);
      } catch (rollbackError) {
        rollbackErrors.push(
          getErrorMessage(rollbackError, "Account rollback failed"),
        );
      }
    }
  }

  return rollbackErrors;
}

function rollbackAppliedRouteBindings(
  applied: PreparedRouteBinding[],
  cause: unknown,
): never {
  const rollbackErrors = restoreAppliedRouteBindings(applied);

  const rollbackSuffix =
    rollbackErrors.length > 0
      ? ` Rollback errors: ${rollbackErrors.join("; ")}`
      : " Changes were rolled back.";
  throw new Error(
    `Failed to update channel routes: ${getErrorMessage(
      cause,
      "Failed to update route",
    )}.${rollbackSuffix}`,
    { cause },
  );
}

export function updateChannelRouteLive(
  channelId: string,
  chatId: string,
  agentId: string,
  conversationId: string,
  accountId?: string,
  threadId?: string | null,
): ChannelRouteSnapshot {
  const binding = prepareRouteBinding({
    channelId,
    chatId,
    accountId,
    threadId,
  });
  const { resolvedAccountId, existingRoute, existingAccount } = binding;

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
      ...(threadId !== undefined ? { threadId } : {}),
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
      existingRoute ? (existingRoute.threadId ?? null) : threadId,
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

function prepareRouteBindings(
  targets: ChannelRouteBindingTarget[],
): PreparedRouteBinding[] {
  const dedupedBindings: PreparedRouteBinding[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const binding = prepareRouteBinding(target);
    const key = routeBindingKey(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedBindings.push(binding);
  }

  return dedupedBindings;
}

export function withChannelRouteBindingsLive<T>(
  targets: ChannelRouteBindingTarget[],
  agentId: string,
  conversationId: string,
  operation: (snapshots: ChannelRouteSnapshot[]) => T,
  rollbackResult?: (result: T) => boolean,
): T {
  const bindings = prepareRouteBindings(targets);
  const applied: PreparedRouteBinding[] = [];
  const snapshots: ChannelRouteSnapshot[] = [];
  try {
    for (const binding of bindings) {
      const snapshot = updateChannelRouteLive(
        binding.target.channelId,
        binding.target.chatId,
        agentId,
        conversationId,
        binding.resolvedAccountId,
        binding.target.threadId,
      );
      applied.push(binding);
      snapshots.push(snapshot);
    }
  } catch (error) {
    rollbackAppliedRouteBindings(applied, error);
  }

  let result: T;
  try {
    result = operation(snapshots);
  } catch (error) {
    rollbackAppliedRouteBindings(applied, error);
  }

  if (rollbackResult?.(result)) {
    const rollbackErrors = restoreAppliedRouteBindings(applied);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Channel route rollback failed: ${rollbackErrors.join("; ")}`,
      );
    }
  }

  return result;
}

export function updateChannelRoutesLive(
  targets: ChannelRouteBindingTarget[],
  agentId: string,
  conversationId: string,
): ChannelRouteSnapshot[] {
  return withChannelRouteBindingsLive(
    targets,
    agentId,
    conversationId,
    (snapshots) => snapshots,
  );
}

export function validateChannelRouteTargets(
  targets: ChannelRouteBindingTarget[],
): ChannelRouteBindingTarget[] {
  const validatedTargets: ChannelRouteBindingTarget[] = [];
  for (const target of targets) {
    const binding = prepareRouteBinding(target);
    if (target.accountId && !binding.existingAccount) {
      throw new Error(
        `Channel account "${target.accountId}" was not found for ${target.channelId}.`,
      );
    }
    if (binding.existingAccount && !binding.existingAccount.enabled) {
      throw new Error(
        `Channel account "${binding.resolvedAccountId}" is disabled for ${target.channelId}.`,
      );
    }
    if (
      binding.existingRoute &&
      (!binding.existingRoute.enabled ||
        binding.existingRoute.outboundEnabled === false)
    ) {
      throw new Error(
        `Channel route "${target.chatId}" is not enabled for outbound messaging.`,
      );
    }
    validatedTargets.push({
      ...target,
      ...(binding.resolvedAccountId
        ? { accountId: binding.resolvedAccountId }
        : {}),
    });
  }
  return validatedTargets;
}
