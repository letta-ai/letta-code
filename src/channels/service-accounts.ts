import { randomUUID } from "node:crypto";
import {
  getChannelAccount,
  getChannelAccountWithSecrets,
  removeChannelAccount,
  upsertChannelAccount,
  upsertChannelAccountWithSecrets,
} from "./accounts";
import { loadPairingStore, removePairingStateForAccount } from "./pairing";
import type { ChannelAccountPatch } from "./plugin-types";
import { ensureChannelRegistry, getChannelRegistry } from "./registry";
import { loadRoutes, removeRoutesForAccount } from "./routing";
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

const DEFAULT_CHANNEL_ACCOUNT_STARTUP_TIMEOUT_MS = 10_000;
let channelAccountStartupTimeoutOverrideMs: number | undefined;
const channelAccountLifecycleGenerations = new Map<string, number>();

export function __testOverrideChannelAccountStartupTimeout(
  timeoutMs: number | undefined,
): void {
  channelAccountStartupTimeoutOverrideMs = timeoutMs;
}

function beginChannelAccountLifecycle(
  channelId: string,
  accountId: string,
): number {
  const key = `${channelId}:${accountId}`;
  const generation = (channelAccountLifecycleGenerations.get(key) ?? 0) + 1;
  channelAccountLifecycleGenerations.set(key, generation);
  return generation;
}

function isCurrentChannelAccountLifecycle(
  channelId: string,
  accountId: string,
  generation: number,
): boolean {
  return (
    channelAccountLifecycleGenerations.get(`${channelId}:${accountId}`) ===
    generation
  );
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
  const existing = await getChannelAccountWithSecrets(channelId, accountId);
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
    try {
      loadRoutes(channelId);
      removeRoutesForAccount(channelId, accountId);
    } catch (error) {
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
  const existing = await getChannelAccountWithSecrets(channelId, accountId);
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

  const updated = await upsertChannelAccountWithSecrets(channelId, nextAccount);

  if (shouldResetRoutes) {
    try {
      loadRoutes(channelId);
      removeRoutesForAccount(channelId, accountId);
    } catch (error) {
      try {
        await upsertChannelAccountWithSecrets(channelId, existing);
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
      throw error;
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
  const lifecycleGeneration = beginChannelAccountLifecycle(
    channelId,
    accountId,
  );
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
    upsertChannelAccount(channelId, {
      ...existing,
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
  }

  const startupController = new AbortController();
  const startupTimeoutMs =
    channelAccountStartupTimeoutOverrideMs ??
    DEFAULT_CHANNEL_ACCOUNT_STARTUP_TIMEOUT_MS;
  let startupTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    startupTimeout = setTimeout(() => {
      startupController.abort(
        new Error(
          `Timed out starting ${channelId} account "${accountId}". Check the credentials and try again.`,
        ),
      );
    }, startupTimeoutMs);
    await ensureChannelRegistry().startChannelAccount(channelId, accountId, {
      signal: startupController.signal,
    });
  } catch (error) {
    if (
      isCurrentChannelAccountLifecycle(
        channelId,
        accountId,
        lifecycleGeneration,
      )
    ) {
      upsertChannelAccount(channelId, {
        ...existing,
        enabled: false,
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    if (startupTimeout) {
      clearTimeout(startupTimeout);
    }
  }
  if (
    !isCurrentChannelAccountLifecycle(channelId, accountId, lifecycleGeneration)
  ) {
    throw new Error(
      `Starting ${channelId}/${accountId} was superseded by a newer lifecycle operation.`,
    );
  }
  const snapshot = await refreshChannelAccountDisplayNameLive(
    channelId,
    accountId,
    {
      force: channelId === "slack" || channelId === "discord",
    },
  );
  if (
    !isCurrentChannelAccountLifecycle(channelId, accountId, lifecycleGeneration)
  ) {
    throw new Error(
      `Starting ${channelId}/${accountId} was superseded by a newer lifecycle operation.`,
    );
  }
  await refreshLoadedMessageChannelTool();
  return snapshot;
}

export async function stopChannelAccountLive(
  channelId: string,
  accountId: string,
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  beginChannelAccountLifecycle(channelId, accountId);
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
  beginChannelAccountLifecycle(channelId, accountId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    return false;
  }

  await getChannelRegistry()?.stopChannelAccount(channelId, accountId);
  loadRoutes(channelId);
  loadTargetStore(channelId);
  loadPairingStore(channelId);
  removeRoutesForAccount(channelId, accountId);
  removeChannelTargetsForAccount(channelId, accountId);
  removePairingStateForAccount(channelId, accountId);
  const removed = removeChannelAccount(channelId, accountId);
  await refreshLoadedMessageChannelTool();
  return removed;
}
