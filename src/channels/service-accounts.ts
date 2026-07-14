import { randomUUID } from "node:crypto";
import {
  captureChannelSecretSnapshots,
  getMutationSecretFieldPaths,
} from "./account-secret-transactions";
import {
  getChannelAccount,
  getChannelAccountWithSecrets,
  removeChannelAccountWithSecrets,
  restoreChannelAccountWithSecretsIfCurrent,
  upsertChannelAccount,
  upsertChannelAccountWithSecrets,
} from "./accounts";
import { getActiveChannelCredentialsStoreMode } from "./credential-store";
import {
  assertAccountHasRequiredCredentials,
  getAccountSecretFieldPaths,
} from "./credential-utils";
import { loadPairingStore, removePairingStateForAccount } from "./pairing";
import type { ChannelAccountPatch } from "./plugin-types";
import { ensureChannelRegistry, getChannelRegistry } from "./registry";
import {
  getRoutesForChannel,
  loadRoutes,
  removeRouteInMemory,
  removeRoutesForAccount,
  setRouteInMemory,
} from "./routing";
import {
  createAccountFromPatch,
  mergeAccountPatch,
} from "./service-account-model";
import {
  assertSupportedChannelId,
  getErrorMessage,
  refreshLoadedMessageChannelTool,
} from "./service-shared";
import {
  isAccountConfigured,
  resolveChannelAccountDisplayName,
  toAccountSnapshot,
} from "./service-snapshots";
import type { ChannelAccountSnapshot } from "./service-types";
import { loadTargetStore, removeChannelTargetsForAccount } from "./targets";
import type { ChannelAccount } from "./types";
import {
  isDiscordChannelAccount,
  isSignalChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";

function snapshotRoutesForAccount(channelId: string, accountId: string) {
  return getRoutesForChannel(channelId, accountId).map((route) => ({
    ...route,
  }));
}

function restoreRoutesForAccountInMemory(
  channelId: string,
  accountId: string,
  routes: ReturnType<typeof snapshotRoutesForAccount>,
): void {
  for (const route of getRoutesForChannel(channelId, accountId)) {
    removeRouteInMemory(
      channelId,
      route.chatId,
      route.accountId,
      route.threadId,
    );
  }
  for (const route of routes) {
    setRouteInMemory(channelId, route);
  }
}

export function createChannelAccountLive(
  channelId: string,
  patch: ChannelAccountPatch,
  options?: { accountId?: string },
): ChannelAccountSnapshot {
  assertSupportedChannelId(channelId);
  const accountId = options?.accountId?.trim() || randomUUID();
  const existing = getChannelAccount(channelId, accountId);
  if (existing) {
    throw new Error(
      `Channel account "${accountId}" already exists for ${channelId}.`,
    );
  }

  const created = upsertChannelAccount(
    channelId,
    createAccountFromPatch(channelId, accountId, patch),
  );
  return toAccountSnapshot(created);
}

export async function createChannelAccountLiveWithSecrets(
  channelId: string,
  patch: ChannelAccountPatch,
  options?: { accountId?: string },
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const accountId = options?.accountId?.trim() || randomUUID();
  const existing = getChannelAccount(channelId, accountId);
  if (existing) {
    throw new Error(
      `Channel account "${accountId}" already exists for ${channelId}.`,
    );
  }

  const created = await upsertChannelAccountWithSecrets(
    channelId,
    createAccountFromPatch(channelId, accountId, patch),
  );
  return toAccountSnapshot(created);
}

export function updateChannelAccountLive(
  channelId: string,
  accountId: string,
  patch: ChannelAccountPatch,
): ChannelAccountSnapshot {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  const nextAccount = mergeAccountPatch(existing, patch);
  const shouldResetRoutes =
    (isSlackChannelAccount(existing) ||
      isDiscordChannelAccount(existing) ||
      isSignalChannelAccount(existing)) &&
    (isSlackChannelAccount(nextAccount) ||
      isDiscordChannelAccount(nextAccount) ||
      isSignalChannelAccount(nextAccount)) &&
    typeof nextAccount.agentId === "string" &&
    nextAccount.agentId !== existing.agentId;

  const updated = upsertChannelAccount(channelId, nextAccount);

  if (shouldResetRoutes) {
    let routeSnapshot: ReturnType<typeof snapshotRoutesForAccount> = [];
    try {
      loadRoutes(channelId);
      routeSnapshot = snapshotRoutesForAccount(channelId, accountId);
      removeRoutesForAccount(channelId, accountId);
    } catch (error) {
      restoreRoutesForAccountInMemory(channelId, accountId, routeSnapshot);
      try {
        upsertChannelAccount(channelId, existing);
      } catch (rollbackError) {
        throw new Error(
          `Failed to reset channel routes after updating account: ${getErrorMessage(
            error,
            "Failed to save routes",
          )}. Failed to restore account: ${getErrorMessage(
            rollbackError,
            "Account rollback failed",
          )}`,
        );
      }

      throw new Error(
        `Failed to reset channel routes after updating account: ${getErrorMessage(
          error,
          "Failed to save routes",
        )}. Account changes were rolled back.`,
      );
    }
  }

  return toAccountSnapshot(updated);
}

export async function updateChannelAccountLiveWithSecrets(
  channelId: string,
  accountId: string,
  patch: ChannelAccountPatch,
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  const nextAccount = mergeAccountPatch(existing, patch);
  const shouldResetRoutes =
    (isSlackChannelAccount(existing) ||
      isDiscordChannelAccount(existing) ||
      isSignalChannelAccount(existing)) &&
    (isSlackChannelAccount(nextAccount) ||
      isDiscordChannelAccount(nextAccount) ||
      isSignalChannelAccount(nextAccount)) &&
    typeof nextAccount.agentId === "string" &&
    nextAccount.agentId !== existing.agentId;

  const credentialsMode = await getActiveChannelCredentialsStoreMode();
  const rollbackSecretSnapshots =
    credentialsMode === "keyring"
      ? await captureChannelSecretSnapshots(
          channelId,
          accountId,
          existing,
          getMutationSecretFieldPaths(existing, nextAccount),
        )
      : [];
  const updated = await upsertChannelAccountWithSecrets(channelId, nextAccount);

  if (shouldResetRoutes) {
    let routeSnapshot: ReturnType<typeof snapshotRoutesForAccount> = [];
    try {
      loadRoutes(channelId);
      routeSnapshot = snapshotRoutesForAccount(channelId, accountId);
      removeRoutesForAccount(channelId, accountId);
    } catch (error) {
      restoreRoutesForAccountInMemory(channelId, accountId, routeSnapshot);
      try {
        const rolledBack = await restoreChannelAccountWithSecretsIfCurrent(
          channelId,
          accountId,
          updated,
          existing,
          rollbackSecretSnapshots,
        );
        if (!rolledBack) {
          throw new Error("account changed after the failed route reset");
        }
      } catch (rollbackError) {
        throw new Error(
          `Failed to reset channel routes after updating account: ${getErrorMessage(
            error,
            "route reset failed",
          )}; rollback also failed: ${getErrorMessage(
            rollbackError,
            "rollback failed",
          )}`,
        );
      }
      throw new Error(
        `Failed to reset channel routes after updating account: ${getErrorMessage(
          error,
          "route reset failed",
        )}. Account changes were rolled back.`,
      );
    }
  }

  return toAccountSnapshot(updated);
}

export async function refreshChannelAccountDisplayNameLive(
  channelId: string,
  accountId: string,
  options?: { force?: boolean },
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = await getChannelAccountWithSecrets(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }
  if (!isAccountConfigured(existing)) {
    return toAccountSnapshot(existing);
  }
  if (existing.displayName) {
    return toAccountSnapshot(existing);
  }

  const resolvedDisplayName = await resolveChannelAccountDisplayName(existing);
  const nextDisplayName =
    options?.force && resolvedDisplayName === undefined
      ? undefined
      : (resolvedDisplayName ?? existing.displayName);

  if (nextDisplayName === existing.displayName) {
    return toAccountSnapshot(existing);
  }

  const updated = await upsertChannelAccountWithSecrets(channelId, {
    ...existing,
    displayName: nextDisplayName,
    updatedAt: new Date().toISOString(),
  });
  return toAccountSnapshot(updated);
}

export function bindChannelAccountLive(
  channelId: string,
  accountId: string,
  agentId: string,
  conversationId: string,
): ChannelAccountSnapshot {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  let updated: ChannelAccount;
  if (isTelegramChannelAccount(existing)) {
    updated = upsertChannelAccount(channelId, {
      ...existing,
      binding: { agentId, conversationId },
      updatedAt: new Date().toISOString(),
    });
  } else if (
    isSlackChannelAccount(existing) ||
    isDiscordChannelAccount(existing) ||
    isWhatsAppChannelAccount(existing) ||
    isSignalChannelAccount(existing)
  ) {
    // Slack, Discord, WhatsApp, and Signal use a top-level agentId.
    updated = upsertChannelAccount(channelId, {
      ...existing,
      agentId,
      updatedAt: new Date().toISOString(),
    });
  } else {
    updated = upsertChannelAccount(channelId, {
      ...existing,
      updatedAt: new Date().toISOString(),
    });
  }

  return toAccountSnapshot(updated);
}

export function unbindChannelAccountLive(
  channelId: string,
  accountId: string,
): ChannelAccountSnapshot {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  let updated: ChannelAccount;
  if (isTelegramChannelAccount(existing)) {
    updated = upsertChannelAccount(channelId, {
      ...existing,
      binding: { agentId: null, conversationId: null },
      updatedAt: new Date().toISOString(),
    });
  } else if (
    isSlackChannelAccount(existing) ||
    isDiscordChannelAccount(existing) ||
    isWhatsAppChannelAccount(existing) ||
    isSignalChannelAccount(existing)
  ) {
    // Slack, Discord, WhatsApp, and Signal use a top-level agentId.
    updated = upsertChannelAccount(channelId, {
      ...existing,
      agentId: null,
      updatedAt: new Date().toISOString(),
    });
  } else {
    updated = upsertChannelAccount(channelId, {
      ...existing,
      updatedAt: new Date().toISOString(),
    });
  }

  return toAccountSnapshot(updated);
}

export async function startChannelAccountLive(
  channelId: string,
  accountId: string,
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = await getChannelAccountWithSecrets(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }
  if (!isAccountConfigured(existing)) {
    if (isTelegramChannelAccount(existing)) {
      throw new Error(
        'Channel "telegram" account is missing a token. Configure it first.',
      );
    }
    if (isDiscordChannelAccount(existing)) {
      throw new Error(
        'Channel "discord" account is missing a token. Configure it first.',
      );
    }
    if (!isSlackChannelAccount(existing)) {
      throw new Error(
        `Channel "${channelId}" account is not configured. Configure it first.`,
      );
    }
    throw new Error(
      'Channel "slack" account is missing a bot token or app token. Configure it first.',
    );
  }

  if (!existing.enabled) {
    assertAccountHasRequiredCredentials(existing);
    await upsertChannelAccountWithSecrets(channelId, {
      ...existing,
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
  }

  let startupTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ensureChannelRegistry().startChannelAccount(channelId, accountId),
      new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out starting ${channelId} account "${accountId}". Check the credentials and try again.`,
            ),
          );
        }, 10_000);
      }),
    ]);
  } catch (error) {
    if (!existing.enabled) {
      try {
        await upsertChannelAccountWithSecrets(channelId, existing);
      } catch (rollbackError) {
        throw new Error(
          `Failed to start ${channelId} account "${accountId}": ${getErrorMessage(
            error,
            "startup failed",
          )}. Failed to restore disabled account: ${getErrorMessage(
            rollbackError,
            "rollback failed",
          )}`,
        );
      }
    }
    throw error;
  } finally {
    if (startupTimeout) {
      clearTimeout(startupTimeout);
    }
  }
  const snapshot = await refreshChannelAccountDisplayNameLive(
    channelId,
    accountId,
    {
      force: channelId === "slack" || channelId === "discord",
    },
  );
  await refreshLoadedMessageChannelTool();
  return snapshot;
}

export async function stopChannelAccountLive(
  channelId: string,
  accountId: string,
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = await getChannelAccountWithSecrets(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  const next = existing.enabled
    ? await upsertChannelAccountWithSecrets(channelId, {
        ...existing,
        enabled: false,
        updatedAt: new Date().toISOString(),
      })
    : existing;

  await getChannelRegistry()?.stopChannelAccount(channelId, accountId);
  await refreshLoadedMessageChannelTool();
  return toAccountSnapshot(next);
}

export async function removeChannelAccountLive(
  channelId: string,
  accountId: string,
): Promise<boolean> {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    return false;
  }

  const credentialsMode = await getActiveChannelCredentialsStoreMode();
  const rollbackSecretSnapshots =
    credentialsMode === "keyring"
      ? await captureChannelSecretSnapshots(
          channelId,
          accountId,
          existing,
          getAccountSecretFieldPaths(existing),
        )
      : [];

  await getChannelRegistry()?.stopChannelAccount(channelId, accountId);
  const removed = await removeChannelAccountWithSecrets(channelId, accountId);
  if (!removed) {
    return false;
  }

  let routeSnapshot: ReturnType<typeof snapshotRoutesForAccount> = [];
  try {
    loadRoutes(channelId);
    routeSnapshot = snapshotRoutesForAccount(channelId, accountId);
    loadTargetStore(channelId);
    loadPairingStore(channelId);
    removeRoutesForAccount(channelId, accountId);
    removeChannelTargetsForAccount(channelId, accountId);
    removePairingStateForAccount(channelId, accountId);
  } catch (error) {
    restoreRoutesForAccountInMemory(channelId, accountId, routeSnapshot);
    try {
      const rolledBack = await restoreChannelAccountWithSecretsIfCurrent(
        channelId,
        accountId,
        null,
        existing,
        rollbackSecretSnapshots,
      );
      if (!rolledBack) {
        throw new Error("account changed after the failed delete cleanup");
      }
    } catch (rollbackError) {
      throw new Error(
        `Deleted ${channelId} account "${accountId}" but failed cleanup: ${getErrorMessage(
          error,
          "cleanup failed",
        )}; rollback also failed: ${getErrorMessage(
          rollbackError,
          "rollback failed",
        )}`,
      );
    }
    throw new Error(
      `Failed to clean up ${channelId} account "${accountId}" after deletion: ${getErrorMessage(
        error,
        "cleanup failed",
      )}. Account changes were rolled back.`,
    );
  }

  await refreshLoadedMessageChannelTool();
  return true;
}
