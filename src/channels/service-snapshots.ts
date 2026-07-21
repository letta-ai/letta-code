import {
  toChannelAccountProtocolConfig,
  toChannelConfigSnapshotProtocolConfig,
} from "./account-config";
import {
  getChannelAccount,
  getChannelAccountWithSecrets,
  listChannelAccounts,
  listChannelAccountsWithSecrets,
} from "./accounts";
import {
  getApprovedUsers,
  getPendingPairings,
  loadPairingStore,
} from "./pairing";
import {
  getChannelDisplayName,
  getSupportedChannelIds,
  loadChannelPlugin,
} from "./plugin-registry";
import { getChannelRegistry } from "./registry";
import type { ChannelRestoreAgentScope } from "./restore-scope";
import { shouldRestoreChannelAccountForAgentScope } from "./restore-scope";
import { getRoutesForChannel, loadRoutes } from "./routing";
import {
  assertSupportedChannelId,
  getSelectedChannelAccount,
  getSelectedChannelAccountWithSecrets,
  normalizeDisplayName,
} from "./service-shared";
import type {
  ChannelAccountSnapshot,
  ChannelConfigSnapshot,
  ChannelSummary,
} from "./service-types";
import type { ChannelAccount, SupportedChannelId } from "./types";
import {
  DEFAULT_SLACK_PERMISSION_MODE,
  isDiscordChannelAccount,
  isSignalChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";

let resolveChannelAccountDisplayNameOverride:
  | ((
      account: ChannelAccount,
    ) => Promise<string | undefined> | string | undefined)
  | null = null;

export async function resolveChannelAccountDisplayName(
  account: ChannelAccount,
): Promise<string | undefined> {
  if (resolveChannelAccountDisplayNameOverride) {
    return normalizeDisplayName(
      await resolveChannelAccountDisplayNameOverride(account),
    );
  }

  try {
    const plugin = await loadChannelPlugin(account.channel);
    return normalizeDisplayName(
      await plugin.resolveAccountDisplayName?.(account),
    );
  } catch {
    return undefined;
  }
}

export function isAccountConfigured(account: ChannelAccount): boolean {
  if (isTelegramChannelAccount(account)) {
    return account.token.trim().length > 0;
  }

  if (isDiscordChannelAccount(account)) {
    return account.token.trim().length > 0;
  }

  if (isWhatsAppChannelAccount(account)) {
    return true;
  }

  if (isSignalChannelAccount(account)) {
    return account.baseUrl.trim().length > 0;
  }

  if (!isSlackChannelAccount(account)) {
    return Object.keys(account.config).length > 0;
  }

  return (
    account.botToken.trim().length > 0 && account.appToken.trim().length > 0
  );
}

export function toAccountSnapshot(
  account: ChannelAccount,
): ChannelAccountSnapshot {
  const running =
    getChannelRegistry()
      ?.getAdapter(account.channel, account.accountId)
      ?.isRunning() ?? false;

  if (isTelegramChannelAccount(account)) {
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
    const config = {
      ...toChannelAccountProtocolConfig(account),
      binding: {
        agent_id: binding.agentId,
        conversation_id: binding.conversationId,
      },
    };

    return {
      channelId: "telegram",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config,
      hasToken: account.token.trim().length > 0,
      transcribeVoice: account.transcribeVoice === true,
      richPrivateChatDefault: account.richPrivateChatDefault !== false,
      richDraftStreaming: account.richDraftStreaming === true,
      groupMode: account.groupMode ?? "open",
      inboundDebounceMs: account.inboundDebounceMs,
      binding,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  if (isDiscordChannelAccount(account)) {
    return {
      channelId: "discord",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelAccountProtocolConfig(account),
      allowedChannels: account.allowedChannels
        ? Array.isArray(account.allowedChannels)
          ? [...account.allowedChannels]
          : { ...account.allowedChannels }
        : [],
      hasToken: account.token.trim().length > 0,
      agentId: account.agentId,
      defaultPermissionMode: account.defaultPermissionMode ?? "standard",
      autoThreadOnMention: account.autoThreadOnMention ?? false,
      threadPolicyByChannel: account.threadPolicyByChannel ?? {},
      acknowledgeMessageReaction: account.acknowledgeMessageReaction ?? false,
      removeStaleRoutes: account.removeStaleRoutes ?? false,
      inboundDebounceMs: account.inboundDebounceMs,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  if (isWhatsAppChannelAccount(account)) {
    return {
      channelId: "whatsapp",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelAccountProtocolConfig(account),
      agentId: account.agentId,
      selfChatMode: account.selfChatMode,
      groupMode: account.groupMode,
      allowedGroups: [...(account.allowedGroups ?? [])],
      mentionPatterns: [...(account.mentionPatterns ?? [])],
      transcribeVoice: account.transcribeVoice === true,
      downloadMedia: account.downloadMedia === true,
      mediaMaxBytes: account.mediaMaxBytes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  if (isSignalChannelAccount(account)) {
    return {
      channelId: "signal",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelAccountProtocolConfig(account),
      agentId: account.agentId,
      selfChatMode: account.selfChatMode,
      groupMode: account.groupMode,
      allowedGroups: [...(account.allowedGroups ?? [])],
      mentionPatterns: [...(account.mentionPatterns ?? [])],
      recipientAliases: { ...(account.recipientAliases ?? {}) },
      transcribeVoice: account.transcribeVoice === true,
      downloadMedia: account.downloadMedia === true,
      mediaMaxBytes: account.mediaMaxBytes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  if (!isSlackChannelAccount(account)) {
    return {
      channelId: account.channel,
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      configured: isAccountConfigured(account),
      running,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelAccountProtocolConfig(account),
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
    config: toChannelAccountProtocolConfig(account),
    hasBotToken: account.botToken.trim().length > 0,
    hasAppToken: account.appToken.trim().length > 0,
    agentId: account.agentId,
    defaultPermissionMode:
      account.defaultPermissionMode ?? DEFAULT_SLACK_PERMISSION_MODE,
    transcribeVoice: account.transcribeVoice === true,
    listenMode: account.listenMode === true,
    allowBots: account.allowBots ?? false,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
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

export function listEnabledChannelIds(options?: {
  restoreAgentScope?: ChannelRestoreAgentScope | null;
}): SupportedChannelId[] {
  return getSupportedChannelIds().filter((channelId) =>
    listChannelAccounts(channelId).some(
      (account) =>
        account.enabled &&
        shouldRestoreChannelAccountForAgentScope(
          account,
          options?.restoreAgentScope,
        ),
    ),
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
  if (isTelegramChannelAccount(account)) {
    return {
      channelId: "telegram",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelConfigSnapshotProtocolConfig(account),
      hasToken: account.token.trim().length > 0,
      transcribeVoice: account.transcribeVoice === true,
      richPrivateChatDefault: account.richPrivateChatDefault !== false,
      richDraftStreaming: account.richDraftStreaming === true,
      groupMode: account.groupMode ?? "open",
      inboundDebounceMs: account.inboundDebounceMs,
    };
  }

  if (isDiscordChannelAccount(account)) {
    return {
      channelId: "discord",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelConfigSnapshotProtocolConfig(account),
      allowedChannels: account.allowedChannels
        ? Array.isArray(account.allowedChannels)
          ? [...account.allowedChannels]
          : { ...account.allowedChannels }
        : [],
      hasToken: account.token.trim().length > 0,
      agentId: account.agentId,
      defaultPermissionMode: account.defaultPermissionMode ?? "standard",
      autoThreadOnMention: account.autoThreadOnMention ?? false,
      threadPolicyByChannel: account.threadPolicyByChannel ?? {},
      acknowledgeMessageReaction: account.acknowledgeMessageReaction ?? false,
      removeStaleRoutes: account.removeStaleRoutes ?? false,
      inboundDebounceMs: account.inboundDebounceMs,
    };
  }

  if (isWhatsAppChannelAccount(account)) {
    return {
      channelId: "whatsapp",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelConfigSnapshotProtocolConfig(account),
      agentId: account.agentId,
      selfChatMode: account.selfChatMode,
      groupMode: account.groupMode,
      allowedGroups: [...(account.allowedGroups ?? [])],
      mentionPatterns: [...(account.mentionPatterns ?? [])],
      transcribeVoice: account.transcribeVoice === true,
      downloadMedia: account.downloadMedia === true,
      mediaMaxBytes: account.mediaMaxBytes,
    };
  }

  if (isSignalChannelAccount(account)) {
    return {
      channelId: "signal",
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelConfigSnapshotProtocolConfig(account),
      agentId: account.agentId,
      selfChatMode: account.selfChatMode,
      groupMode: account.groupMode,
      allowedGroups: [...(account.allowedGroups ?? [])],
      mentionPatterns: [...(account.mentionPatterns ?? [])],
      recipientAliases: { ...(account.recipientAliases ?? {}) },
      transcribeVoice: account.transcribeVoice === true,
      downloadMedia: account.downloadMedia === true,
      mediaMaxBytes: account.mediaMaxBytes,
    };
  }

  if (!isSlackChannelAccount(account)) {
    return {
      channelId: account.channel,
      accountId: account.accountId,
      displayName: account.displayName,
      enabled: account.enabled,
      dmPolicy: account.dmPolicy,
      allowedUsers: [...account.allowedUsers],
      config: toChannelConfigSnapshotProtocolConfig(account),
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
    config: toChannelConfigSnapshotProtocolConfig(account),
    hasBotToken: account.botToken.trim().length > 0,
    hasAppToken: account.appToken.trim().length > 0,
    agentId: account.agentId,
    defaultPermissionMode:
      account.defaultPermissionMode ?? DEFAULT_SLACK_PERMISSION_MODE,
    transcribeVoice: account.transcribeVoice === true,
    listenMode: account.listenMode === true,
    allowBots: account.allowBots ?? false,
  };
}

export async function getChannelConfigSnapshotWithSecrets(
  channelId: string,
  accountId?: string,
): Promise<ChannelConfigSnapshot | null> {
  assertSupportedChannelId(channelId);
  await getSelectedChannelAccountWithSecrets(channelId, accountId);
  return getChannelConfigSnapshot(channelId, accountId);
}

export function listChannelAccountSnapshots(
  channelId: string,
): ChannelAccountSnapshot[] {
  assertSupportedChannelId(channelId);
  return listChannelAccounts(channelId).map(toAccountSnapshot);
}

export async function listChannelAccountSnapshotsWithSecrets(
  channelId: string,
): Promise<ChannelAccountSnapshot[]> {
  assertSupportedChannelId(channelId);
  return (await listChannelAccountsWithSecrets(channelId)).map(
    toAccountSnapshot,
  );
}

export function getChannelAccountSnapshot(
  channelId: string,
  accountId: string,
): ChannelAccountSnapshot | null {
  assertSupportedChannelId(channelId);
  const account = getChannelAccount(channelId, accountId);
  return account ? toAccountSnapshot(account) : null;
}

export async function getChannelAccountSnapshotWithSecrets(
  channelId: string,
  accountId: string,
): Promise<ChannelAccountSnapshot | null> {
  assertSupportedChannelId(channelId);
  const account = await getChannelAccountWithSecrets(channelId, accountId);
  return account ? toAccountSnapshot(account) : null;
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
