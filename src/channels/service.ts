import { randomUUID } from "node:crypto";
import { refreshDynamicChannelToolsInLoadedRegistry } from "../tools/manager";
import {
  getChannelAccount,
  LEGACY_CHANNEL_ACCOUNT_ID,
  listChannelAccounts,
  removeChannelAccount,
  upsertChannelAccount,
} from "./accounts";
import { resolveDiscordAccountDisplayName } from "./discord/adapter";
import {
  getApprovedUsers,
  getPendingPairings,
  loadPairingStore,
  removePairingStateForAccount,
} from "./pairing";
import {
  getChannelDisplayName,
  getSupportedChannelIds,
  isSupportedChannelId,
} from "./pluginRegistry";
import {
  completePairing,
  ensureChannelRegistry,
  getChannelRegistry,
} from "./registry";
import {
  addRoute,
  getRoute,
  getRoutesForChannel,
  loadRoutes,
  removeRoute,
  removeRouteInMemory,
  removeRoutesForAccount,
  setRouteInMemory,
} from "./routing";
import { resolveSlackAccountDisplayName } from "./slack/adapter";
import {
  listChannelTargets,
  loadTargetStore,
  removeChannelTarget,
  removeChannelTargetsForAccount,
  upsertChannelTarget,
} from "./targets";
import { validateTelegramToken } from "./telegram/adapter";
import type {
  ChannelAccount,
  ChannelBindableTarget,
  ChannelRoute,
  DmPolicy,
  PendingPairing,
  SlackChannelMode,
  SlackDefaultPermissionMode,
  SupportedChannelId,
} from "./types";

export interface ChannelSummary {
  channelId: SupportedChannelId;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  running: boolean;
  dmPolicy: DmPolicy | null;
  pendingPairingsCount: number;
  approvedUsersCount: number;
  routesCount: number;
}

export type ChannelConfigSnapshot =
  | {
      channelId: "telegram";
      accountId: string;
      displayName?: string;
      enabled: boolean;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasToken: boolean;
    }
  | {
      channelId: "slack";
      accountId: string;
      displayName?: string;
      enabled: boolean;
      mode: SlackChannelMode;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasBotToken: boolean;
      hasAppToken: boolean;
    }
  | {
      channelId: "discord";
      accountId: string;
      displayName?: string;
      enabled: boolean;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasToken: boolean;
    };

export interface PendingPairingSnapshot {
  accountId: string;
  code: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelRouteSnapshot {
  channelId: SupportedChannelId;
  accountId: string;
  chatId: string;
  chatType?: "direct" | "channel";
  threadId?: string | null;
  agentId: string;
  conversationId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelTargetSnapshot {
  channelId: SupportedChannelId;
  accountId: string;
  targetId: string;
  targetType: "channel";
  chatId: string;
  label: string;
  discoveredAt: string;
  lastSeenAt: string;
  lastMessageId?: string;
}

async function refreshLoadedMessageChannelTool(): Promise<void> {
  await refreshDynamicChannelToolsInLoadedRegistry();
}

export type ChannelAccountSnapshot =
  | {
      channelId: "telegram";
      accountId: string;
      displayName?: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasToken: boolean;
      binding: {
        agentId: string | null;
        conversationId: string | null;
      };
      createdAt: string;
      updatedAt: string;
    }
  | {
      channelId: "slack";
      accountId: string;
      displayName?: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      mode: SlackChannelMode;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasBotToken: boolean;
      hasAppToken: boolean;
      agentId: string | null;
      defaultPermissionMode: SlackDefaultPermissionMode;
      createdAt: string;
      updatedAt: string;
    }
  | {
      channelId: "discord";
      accountId: string;
      displayName?: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      dmPolicy: DmPolicy;
      allowedUsers: string[];
      hasToken: boolean;
      agentId: string | null;
      createdAt: string;
      updatedAt: string;
    };

export interface ChannelConfigPatch {
  token?: string;
  botToken?: string;
  appToken?: string;
  mode?: SlackChannelMode;
  dmPolicy?: DmPolicy;
  allowedUsers?: string[];
}

export interface ChannelAccountPatch {
  displayName?: string;
  enabled?: boolean;
  token?: string;
  botToken?: string;
  appToken?: string;
  mode?: SlackChannelMode;
  agentId?: string | null;
  defaultPermissionMode?: SlackDefaultPermissionMode;
  dmPolicy?: DmPolicy;
  allowedUsers?: string[];
}

let resolveChannelAccountDisplayNameOverride:
  | ((
      account: ChannelAccount,
    ) => Promise<string | undefined> | string | undefined)
  | null = null;

function assertSupportedChannelId(
  channelId: string,
): asserts channelId is SupportedChannelId {
  if (!isSupportedChannelId(channelId)) {
    throw new Error(`Unsupported channel: ${channelId}`);
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function resolveChannelAccountDisplayName(
  account: ChannelAccount,
): Promise<string | undefined> {
  if (resolveChannelAccountDisplayNameOverride) {
    return normalizeDisplayName(
      await resolveChannelAccountDisplayNameOverride(account),
    );
  }

  try {
    if (account.channel === "telegram") {
      if (!account.token.trim()) {
        return undefined;
      }
      const info = await validateTelegramToken(account.token);
      return normalizeDisplayName(
        info.username ? `@${info.username}` : undefined,
      );
    }

    if (account.channel === "discord") {
      if (!account.token.trim()) {
        return undefined;
      }
      return normalizeDisplayName(
        await resolveDiscordAccountDisplayName(account.token),
      );
    }

    if (!account.botToken.trim() || !account.appToken.trim()) {
      return undefined;
    }

    return normalizeDisplayName(
      await resolveSlackAccountDisplayName(account.botToken, account.appToken),
    );
  } catch {
    return undefined;
  }
}

function getSelectedChannelAccount(
  channelId: SupportedChannelId,
  accountId?: string,
): ChannelAccount | null {
  const normalizedAccountId = accountId?.trim();
  if (normalizedAccountId) {
    return getChannelAccount(channelId, normalizedAccountId);
  }

  const accounts = listChannelAccounts(channelId);
  if (accounts.length === 0) {
    return null;
  }
  if (accounts.length === 1) {
    return accounts[0] ?? null;
  }

  throw new Error(
    `Channel "${channelId}" has multiple accounts. Specify account_id.`,
  );
}

function getSelectedRouteByChatId(
  channelId: SupportedChannelId,
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
  channelId: SupportedChannelId,
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
  channelId: SupportedChannelId,
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
    createdAt: route.createdAt,
    updatedAt: route.updatedAt ?? route.createdAt,
  };
}

function toTargetSnapshot(
  channelId: SupportedChannelId,
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

function isAccountConfigured(account: ChannelAccount): boolean {
  if (account.channel === "telegram") {
    return account.token.trim().length > 0;
  }

  if (account.channel === "discord") {
    return account.token.trim().length > 0;
  }

  return (
    account.botToken.trim().length > 0 && account.appToken.trim().length > 0
  );
}

function toAccountSnapshot(account: ChannelAccount): ChannelAccountSnapshot {
  const running =
    getChannelRegistry()
      ?.getAdapter(account.channel, account.accountId)
      ?.isRunning() ?? false;

  if (account.channel === "telegram") {
    loadRoutes(account.channel);
    const fallbackRoute = getRoutesForChannel(
      account.channel,
      account.accountId,
    ).find((route) => route.enabled !== false);
    const binding =
      account.binding.agentId && account.binding.conversationId
        ? { ...account.binding }
        : fallbackRoute
          ? {
              agentId: fallbackRoute.agentId,
              conversationId: fallbackRoute.conversationId,
            }
          : { ...account.binding };

    return {
      channelId: "telegram",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      hasToken: account.token.trim().length > 0,
      binding,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  if (account.channel === "discord") {
    return {
      channelId: "discord",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      hasToken: account.token.trim().length > 0,
      agentId: account.agentId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  return {
    channelId: "slack",
    accountId: account.accountId,
    displayName: account.displayName,
    enabled: account.enabled,
    configured: isAccountConfigured(account),
    running,
    mode: account.mode,
    dmPolicy: account.dmPolicy,
    allowedUsers: [...account.allowedUsers],
    hasBotToken: account.botToken.trim().length > 0,
    hasAppToken: account.appToken.trim().length > 0,
    agentId: account.agentId,
    defaultPermissionMode: account.defaultPermissionMode ?? "default",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function createAccountFromPatch(
  channelId: SupportedChannelId,
  accountId: string,
  patch: ChannelAccountPatch,
): ChannelAccount {
  const now = new Date().toISOString();
  if (channelId === "telegram") {
    return {
      channel: "telegram",
      accountId,
      displayName: normalizeDisplayName(patch.displayName),
      enabled: patch.enabled ?? false,
      token: patch.token ?? "",
      dmPolicy: patch.dmPolicy ?? "pairing",
      allowedUsers: patch.allowedUsers ?? [],
      binding: {
        agentId: null,
        conversationId: null,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  if (channelId === "discord") {
    return {
      channel: "discord",
      accountId,
      displayName: normalizeDisplayName(patch.displayName),
      enabled: patch.enabled ?? false,
      token: patch.token ?? "",
      agentId: patch.agentId ?? null,
      dmPolicy: patch.dmPolicy ?? "pairing",
      allowedUsers: patch.allowedUsers ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    channel: "slack",
    accountId,
    displayName: normalizeDisplayName(patch.displayName),
    enabled: patch.enabled ?? false,
    mode: patch.mode ?? "socket",
    botToken: patch.botToken ?? "",
    appToken: patch.appToken ?? "",
    agentId: patch.agentId ?? null,
    defaultPermissionMode: patch.defaultPermissionMode ?? "default",
    dmPolicy: patch.dmPolicy ?? "open",
    allowedUsers: patch.allowedUsers ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

function mergeAccountPatch(
  existing: ChannelAccount,
  patch: ChannelAccountPatch,
): ChannelAccount {
  const nextUpdatedAt = new Date().toISOString();
  if (existing.channel === "telegram") {
    return {
      ...existing,
      displayName:
        patch.displayName !== undefined
          ? normalizeDisplayName(patch.displayName)
          : existing.displayName,
      enabled: patch.enabled ?? existing.enabled,
      token: patch.token ?? existing.token,
      dmPolicy: patch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: patch.allowedUsers ?? existing.allowedUsers,
      updatedAt: nextUpdatedAt,
    };
  }

  if (existing.channel === "discord") {
    return {
      ...existing,
      displayName:
        patch.displayName !== undefined
          ? normalizeDisplayName(patch.displayName)
          : existing.displayName,
      enabled: patch.enabled ?? existing.enabled,
      token: patch.token ?? existing.token,
      agentId: patch.agentId ?? existing.agentId,
      dmPolicy: patch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: patch.allowedUsers ?? existing.allowedUsers,
      updatedAt: nextUpdatedAt,
    };
  }

  return {
    ...existing,
    displayName:
      patch.displayName !== undefined
        ? normalizeDisplayName(patch.displayName)
        : existing.displayName,
    enabled: patch.enabled ?? existing.enabled,
    mode: patch.mode ?? existing.mode,
    botToken: patch.botToken ?? existing.botToken,
    appToken: patch.appToken ?? existing.appToken,
    agentId: patch.agentId ?? existing.agentId,
    defaultPermissionMode:
      patch.defaultPermissionMode ??
      existing.defaultPermissionMode ??
      "default",
    dmPolicy: patch.dmPolicy ?? existing.dmPolicy,
    allowedUsers: patch.allowedUsers ?? existing.allowedUsers,
    updatedAt: nextUpdatedAt,
  };
}

export function listChannelSummaries(): ChannelSummary[] {
  const registry = getChannelRegistry();
  const activeChannelIds = new Set(registry?.getActiveChannelIds() ?? []);
  return getSupportedChannelIds().map((channelId) => {
    const accounts = listChannelAccounts(channelId);
    if (accounts.length === 0) {
      return {
        channelId,
        displayName: getChannelDisplayName(channelId),
        configured: false,
        enabled: false,
        running: false,
        dmPolicy: null,
        pendingPairingsCount: 0,
        approvedUsersCount: 0,
        routesCount: 0,
      };
    }

    loadRoutes(channelId);
    loadPairingStore(channelId);

    return {
      channelId,
      displayName: getChannelDisplayName(channelId),
      configured: accounts.length > 0,
      enabled: accounts.some((account) => account.enabled),
      running: activeChannelIds.has(channelId),
      dmPolicy: accounts[0]?.dmPolicy ?? null,
      pendingPairingsCount: getPendingPairings(channelId).length,
      approvedUsersCount: getApprovedUsers(channelId).length,
      routesCount: getRoutesForChannel(channelId).length,
    };
  });
}

export function listEnabledChannelIds(): SupportedChannelId[] {
  return getSupportedChannelIds().filter((channelId) =>
    listChannelAccounts(channelId).some((account) => account.enabled),
  );
}

export function getChannelConfigSnapshot(
  channelId: string,
  accountId?: string,
): ChannelConfigSnapshot | null {
  assertSupportedChannelId(channelId);
  const account = getSelectedChannelAccount(channelId, accountId);
  if (!account) {
    return null;
  }
  if (account.channel === "telegram") {
    return {
      channelId: "telegram",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      hasToken: account.token.trim().length > 0,
    };
  }

  if (account.channel === "discord") {
    return {
      channelId: "discord",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      hasToken: account.token.trim().length > 0,
    };
  }

  return {
    channelId: "slack",
    accountId: account.accountId,
    displayName: account.displayName,
    enabled: account.enabled,
    mode: account.mode,
    dmPolicy: account.dmPolicy,
    allowedUsers: [...account.allowedUsers],
    hasBotToken: account.botToken.trim().length > 0,
    hasAppToken: account.appToken.trim().length > 0,
  };
}

export async function setChannelConfigLive(
  channelId: string,
  patch: ChannelConfigPatch,
  accountId?: string,
): Promise<ChannelConfigSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = getSelectedChannelAccount(channelId, accountId);
  let targetAccountId = existing?.accountId;
  let shouldRefreshDisplayName = false;
  if (existing) {
    updateChannelAccountLive(channelId, existing.accountId, {
      enabled: existing.enabled,
      token: patch.token,
      botToken: patch.botToken,
      appToken: patch.appToken,
      mode: patch.mode,
      dmPolicy: patch.dmPolicy,
      allowedUsers: patch.allowedUsers,
      displayName: existing.displayName,
    });
    shouldRefreshDisplayName =
      channelId === "telegram" || channelId === "discord"
        ? patch.token !== undefined
        : patch.botToken !== undefined || patch.appToken !== undefined;
  } else {
    const created = createChannelAccountLive(
      channelId,
      {
        enabled: false,
        token: patch.token,
        botToken: patch.botToken,
        appToken: patch.appToken,
        mode: patch.mode,
        dmPolicy: patch.dmPolicy,
        allowedUsers: patch.allowedUsers,
      },
      accountId ? { accountId } : undefined,
    );
    targetAccountId = created.accountId;
    shouldRefreshDisplayName = true;
  }

  if (existing) {
    targetAccountId = existing.accountId;
  }

  if (!targetAccountId) {
    throw new Error(`Failed to resolve ${channelId} account after update.`);
  }

  if (shouldRefreshDisplayName) {
    await refreshChannelAccountDisplayNameLive(channelId, targetAccountId, {
      force: true,
    });
  }

  if (
    (getChannelAccount(channelId, targetAccountId)?.enabled ?? false) === true
  ) {
    await ensureChannelRegistry().startChannelAccount(
      channelId,
      targetAccountId,
    );
  }

  const snapshot = getChannelConfigSnapshot(channelId, targetAccountId);
  if (!snapshot) {
    throw new Error(`Failed to write ${channelId} channel config`);
  }
  await refreshLoadedMessageChannelTool();
  return snapshot;
}

export async function startChannelLive(
  channelId: string,
  accountId?: string,
): Promise<ChannelSummary> {
  assertSupportedChannelId(channelId);

  const existing = getSelectedChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }
  if (!isAccountConfigured(existing)) {
    if (existing.channel === "telegram") {
      throw new Error(
        'Channel "telegram" is missing a token. Configure it first.',
      );
    }
    if (existing.channel === "discord") {
      throw new Error(
        'Channel "discord" is missing a token. Configure it first.',
      );
    }
    throw new Error(
      'Channel "slack" is missing a bot token or app token. Configure it first.',
    );
  }

  if (!existing.enabled) {
    upsertChannelAccount(channelId, {
      ...existing,
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
  }

  await ensureChannelRegistry().startChannelAccount(
    channelId,
    existing.accountId,
  );
  await refreshChannelAccountDisplayNameLive(channelId, existing.accountId, {
    force: channelId === "slack" || channelId === "discord",
  });

  const summary = listChannelSummaries().find(
    (entry) => entry.channelId === channelId,
  );
  if (!summary) {
    throw new Error(`Channel "${channelId}" summary not found after start`);
  }
  await refreshLoadedMessageChannelTool();
  return summary;
}

export async function stopChannelLive(
  channelId: string,
  accountId?: string,
): Promise<ChannelSummary> {
  assertSupportedChannelId(channelId);

  const existing = getSelectedChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }

  upsertChannelAccount(channelId, {
    ...existing,
    enabled: false,
    updatedAt: new Date().toISOString(),
  });

  await getChannelRegistry()?.stopChannelAccount(channelId, existing.accountId);

  const summary = listChannelSummaries().find(
    (entry) => entry.channelId === channelId,
  );
  if (!summary) {
    throw new Error(`Channel "${channelId}" summary not found after stop`);
  }
  await refreshLoadedMessageChannelTool();
  return summary;
}

export function listChannelAccountSnapshots(
  channelId: string,
): ChannelAccountSnapshot[] {
  assertSupportedChannelId(channelId);
  return listChannelAccounts(channelId).map(toAccountSnapshot);
}

export function getChannelAccountSnapshot(
  channelId: string,
  accountId: string,
): ChannelAccountSnapshot | null {
  assertSupportedChannelId(channelId);
  const account = getChannelAccount(channelId, accountId);
  return account ? toAccountSnapshot(account) : null;
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

  const updated = upsertChannelAccount(
    channelId,
    mergeAccountPatch(existing, patch),
  );
  return toAccountSnapshot(updated);
}

export async function refreshChannelAccountDisplayNameLive(
  channelId: string,
  accountId: string,
  options?: { force?: boolean },
): Promise<ChannelAccountSnapshot> {
  assertSupportedChannelId(channelId);
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }
  if (!isAccountConfigured(existing)) {
    return toAccountSnapshot(existing);
  }
  if (!options?.force && existing.displayName) {
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

  const updated = upsertChannelAccount(channelId, {
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
  if (existing.channel === "telegram") {
    updated = upsertChannelAccount(channelId, {
      ...existing,
      binding: { agentId, conversationId },
      updatedAt: new Date().toISOString(),
    });
  } else {
    // Slack and Discord both use a top-level agentId
    updated = upsertChannelAccount(channelId, {
      ...existing,
      agentId,
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
  if (existing.channel === "telegram") {
    updated = upsertChannelAccount(channelId, {
      ...existing,
      binding: { agentId: null, conversationId: null },
      updatedAt: new Date().toISOString(),
    });
  } else {
    // Slack and Discord both use a top-level agentId
    updated = upsertChannelAccount(channelId, {
      ...existing,
      agentId: null,
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
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }
  if (!isAccountConfigured(existing)) {
    if (existing.channel === "telegram") {
      throw new Error(
        'Channel "telegram" account is missing a token. Configure it first.',
      );
    }
    if (existing.channel === "discord") {
      throw new Error(
        'Channel "discord" account is missing a token. Configure it first.',
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

  await ensureChannelRegistry().startChannelAccount(channelId, accountId);
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
  const existing = getChannelAccount(channelId, accountId);
  if (!existing) {
    throw new Error(
      `Channel account "${accountId}" was not found for ${channelId}.`,
    );
  }

  const next = existing.enabled
    ? upsertChannelAccount(channelId, {
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
  if (!existingRoute) {
    throw new Error(`Route "${channelId}:${chatId}" was not found.`);
  }

  const resolvedAccountId = existingRoute.accountId ?? accountId;
  const existingAccount = resolvedAccountId
    ? getChannelAccount(channelId, resolvedAccountId)
    : null;

  if (existingAccount?.channel === "telegram") {
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
    ...existingRoute,
    agentId,
    conversationId,
    updatedAt: new Date().toISOString(),
  };

  try {
    addRoute(channelId, updatedRoute);
  } catch (error) {
    removeRouteInMemory(
      channelId,
      chatId,
      resolvedAccountId,
      existingRoute.threadId,
    );
    setRouteInMemory(channelId, existingRoute);

    if (existingAccount?.channel === "telegram") {
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

export function __testOverrideResolveChannelAccountDisplayName(
  fn:
    | ((
        account: ChannelAccount,
      ) => Promise<string | undefined> | string | undefined)
    | null,
): void {
  resolveChannelAccountDisplayNameOverride = fn;
}
