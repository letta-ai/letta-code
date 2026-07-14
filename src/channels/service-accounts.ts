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
  upsertChannelAccountMetadataIfCurrent,
  upsertChannelAccountWithSecrets,
} from "./accounts";
import { getActiveChannelCredentialsStoreMode } from "./credential-store";
import {
  assertAccountHasRequiredCredentials,
  getAccountSecretFieldPaths,
} from "./credential-utils";
import {
  loadPairingStore,
  removePairingStateForAccount,
  restorePairingStateForAccountSnapshot,
  snapshotPairingStateForAccount,
} from "./pairing";
import type { ChannelAccountPatch } from "./plugin-types";
import { ensureChannelRegistry, getChannelRegistry } from "./registry";
import {
  getRoutesForChannel,
  loadRoutes,
  removeRouteInMemory,
  removeRoutesForAccount,
  saveRoutes,
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
import {
  loadTargetStore,
  removeChannelTargetsForAccount,
  restoreChannelTargetsForAccountSnapshot,
  snapshotChannelTargetsForAccount,
} from "./targets";
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

function restoreRoutesForAccount(
  channelId: string,
  accountId: string,
  routes: ReturnType<typeof snapshotRoutesForAccount>,
  options: { persist?: boolean } = {},
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
  if (options.persist === true) {
    saveRoutes(channelId);
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
    { expectedCurrent: null },
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
      restoreRoutesForAccount(channelId, accountId, routeSnapshot);
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
  const updated = await upsertChannelAccountWithSecrets(
    channelId,
    nextAccount,
    {
      expectedCurrent: existing,
    },
  );

  if (shouldResetRoutes) {
    let routeSnapshot: ReturnType<typeof snapshotRoutesForAccount> = [];
    try {
      loadRoutes(channelId);
      routeSnapshot = snapshotRoutesForAccount(channelId, accountId);
      removeRoutesForAccount(channelId, accountId);
    } catch (error) {
      restoreRoutesForAccount(channelId, accountId, routeSnapshot);
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

  const updated = await upsertChannelAccountWithSecrets(
    channelId,
    {
      ...existing,
      displayName: nextDisplayName,
      updatedAt: new Date().toISOString(),
    },
    { expectedCurrent: existing },
  );
  return toAccountSnapshot(updated);
}

export async function bindChannelAccountLive(
  channelId: string,
  accountId: string,
  agentId: string,
  conversationId: string,
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  let updated: ChannelAccount;
  if (isTelegramChannelAccount(existing)) {
    updated = upsertChannelAccountMetadataIfCurrent(
      channelId,
      {
        ...existing,
        binding: { agentId, conversationId },
        updatedAt: new Date().toISOString(),
      },
      existing,
    );
  } else if (
    isSlackChannelAccount(existing) ||
    isDiscordChannelAccount(existing) ||
    isWhatsAppChannelAccount(existing) ||
    isSignalChannelAccount(existing)
  ) {
    // Slack, Discord, WhatsApp, and Signal use a top-level agentId.
    updated = upsertChannelAccountMetadataIfCurrent(
      channelId,
      {
        ...existing,
        agentId,
        updatedAt: new Date().toISOString(),
      },
      existing,
    );
  } else {
    updated = upsertChannelAccountMetadataIfCurrent(
      channelId,
      {
        ...existing,
        updatedAt: new Date().toISOString(),
      },
      existing,
    );
  }

  return toAccountSnapshot(updated);
}

export async function unbindChannelAccountLive(
  channelId: string,
  accountId: string,
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  let updated: ChannelAccount;
  if (isTelegramChannelAccount(existing)) {
    updated = upsertChannelAccountMetadataIfCurrent(
      channelId,
      {
        ...existing,
        binding: { agentId: null, conversationId: null },
        updatedAt: new Date().toISOString(),
      },
      existing,
    );
  } else if (
    isSlackChannelAccount(existing) ||
    isDiscordChannelAccount(existing) ||
    isWhatsAppChannelAccount(existing) ||
    isSignalChannelAccount(existing)
  ) {
    // Slack, Discord, WhatsApp, and Signal use a top-level agentId.
    updated = upsertChannelAccountMetadataIfCurrent(
      channelId,
      {
        ...existing,
        agentId: null,
        updatedAt: new Date().toISOString(),
      },
      existing,
    );
  } else {
    updated = upsertChannelAccountMetadataIfCurrent(
      channelId,
      {
        ...existing,
        updatedAt: new Date().toISOString(),
      },
      existing,
    );
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

  let enabledAccount: ChannelAccount | null = null;
  if (!existing.enabled) {
    assertAccountHasRequiredCredentials(existing);
    enabledAccount = await upsertChannelAccountWithSecrets(
      channelId,
      {
        ...existing,
        enabled: true,
        updatedAt: new Date().toISOString(),
      },
      { expectedCurrent: existing },
    );
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
        await upsertChannelAccountWithSecrets(channelId, existing, {
          expectedCurrent: enabledAccount,
        });
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
    ? await upsertChannelAccountWithSecrets(
        channelId,
        {
          ...existing,
          enabled: false,
          updatedAt: new Date().toISOString(),
        },
        { expectedCurrent: existing },
      )
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
  const removed = await removeChannelAccountWithSecrets(channelId, accountId, {
    expectedCurrent: existing,
  });
  if (!removed) {
    return false;
  }

  let routeSnapshot: ReturnType<typeof snapshotRoutesForAccount> = [];
  let targetSnapshot: ReturnType<typeof snapshotChannelTargetsForAccount> = [];
  let pairingSnapshot: ReturnType<typeof snapshotPairingStateForAccount> = {
    pending: [],
    approved: [],
  };
  let routeSnapshotCaptured = false;
  let targetSnapshotCaptured = false;
  let pairingSnapshotCaptured = false;
  let routesCleaned = false;
  let targetsCleaned = false;
  try {
    loadRoutes(channelId);
    routeSnapshot = snapshotRoutesForAccount(channelId, accountId);
    routeSnapshotCaptured = true;
    loadTargetStore(channelId);
    targetSnapshot = snapshotChannelTargetsForAccount(channelId, accountId);
    targetSnapshotCaptured = true;
    loadPairingStore(channelId);
    pairingSnapshot = snapshotPairingStateForAccount(channelId, accountId);
    pairingSnapshotCaptured = true;
    removeRoutesForAccount(channelId, accountId);
    routesCleaned = true;
    removeChannelTargetsForAccount(channelId, accountId);
    targetsCleaned = true;
    removePairingStateForAccount(channelId, accountId);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (routeSnapshotCaptured) {
      try {
        restoreRoutesForAccount(channelId, accountId, routeSnapshot, {
          persist: routesCleaned,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        restoreRoutesForAccount(channelId, accountId, routeSnapshot);
      }
    }
    if (targetSnapshotCaptured) {
      try {
        restoreChannelTargetsForAccountSnapshot(
          channelId,
          accountId,
          targetSnapshot,
          { persist: targetsCleaned },
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        restoreChannelTargetsForAccountSnapshot(
          channelId,
          accountId,
          targetSnapshot,
          { persist: false },
        );
      }
    }
    if (pairingSnapshotCaptured) {
      restorePairingStateForAccountSnapshot(
        channelId,
        accountId,
        pairingSnapshot,
        { persist: false },
      );
    }
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
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Deleted ${channelId} account "${accountId}" but failed cleanup: ${getErrorMessage(
          error,
          "cleanup failed",
        )}; rollback also failed: ${rollbackErrors
          .map((rollbackError) =>
            getErrorMessage(rollbackError, "rollback failed"),
          )
          .join("; ")}`,
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
