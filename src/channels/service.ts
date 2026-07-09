import { randomUUID } from "node:crypto";
import { refreshDynamicChannelToolsInLoadedRegistry } from "@/tools/manager";
import {
  channelPluginConfigShouldRefreshDisplayName,
  normalizeChannelAccountPatch,
  normalizeChannelConfigPatch,
  toChannelAccountProtocolConfig,
  toChannelConfigSnapshotProtocolConfig,
} from "./account-config";
import {
  getChannelAccount,
  getChannelAccountWithSecrets,
  LEGACY_CHANNEL_ACCOUNT_ID,
  listChannelAccounts,
  listChannelAccountsWithSecrets,
  removeChannelAccount,
  upsertChannelAccount,
  upsertChannelAccountWithSecrets,
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
} from "./plugin-registry";
import type {
  ChannelAccountPatch,
  ChannelConfigPatch,
  ChannelProtocolConfig,
} from "./plugin-types";
import {
  completePairing,
  ensureChannelRegistry,
  getChannelRegistry,
} from "./registry";
import type { ChannelRestoreAgentScope } from "./restore-scope";
import { shouldRestoreChannelAccountForAgentScope } from "./restore-scope";
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
import { resolveSlackAccountDisplayName } from "./slack/account-display";
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
  ChannelDefaultPermissionMode,
  ChannelRoute,
  CustomChannelAccount,
  DiscordChannelMode,
  DmPolicy,
  PendingPairing,
  SignalGroupMode,
  SlackChannelMode,
  SupportedChannelId,
  TelegramGroupMode,
  WhatsAppGroupMode,
} from "./types";
import {
  DEFAULT_SLACK_PERMISSION_MODE,
  isDiscordChannelAccount,
  isSignalChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";

export interface ChannelSummary {
  channelId: string;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  running: boolean;
  dmPolicy: DmPolicy | null;
  pendingPairingsCount: number;
  approvedUsersCount: number;
  routesCount: number;
}

export interface ChannelConfigSnapshot {
  [key: string]: unknown;
  channelId: string;
  accountId: string;
  displayName?: string;
  enabled: boolean;
  mode?: SlackChannelMode;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  config: ChannelProtocolConfig;
  hasToken?: boolean;
  hasBotToken?: boolean;
  hasAppToken?: boolean;
  groupMode?: TelegramGroupMode | WhatsAppGroupMode | SignalGroupMode;
  agentId?: string | null;
  defaultPermissionMode?: ChannelDefaultPermissionMode;
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  autoThreadOnMention?: boolean;
  threadPolicyByChannel?: Record<string, boolean>;
  acknowledgeMessageReaction?: boolean;
  listenMode?: boolean;
  removeStaleRoutes?: boolean;
  inboundDebounceMs?: number;
  selfChatMode?: boolean;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  recipientAliases?: Record<string, string>;
  transcribeVoice?: boolean;
  richPrivateChatDefault?: boolean;
  richDraftStreaming?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
}

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
  channelId: string;
  accountId: string;
  chatId: string;
  chatType?: "direct" | "channel";
  threadId?: string | null;
  agentId: string;
  conversationId: string;
  enabled: boolean;
  outboundEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelTargetSnapshot {
  channelId: string;
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

function normalizeTelegramGroupMode(
  value: ChannelAccountPatch["groupMode"],
): TelegramGroupMode | undefined {
  return value === "open" || value === "mention-only" ? value : undefined;
}

function normalizeWhatsAppGroupMode(
  value: ChannelAccountPatch["groupMode"],
): WhatsAppGroupMode | undefined {
  return value === "disabled" || value === "mention" || value === "open"
    ? value
    : undefined;
}

function normalizeSignalGroupMode(
  value: ChannelAccountPatch["groupMode"],
): SignalGroupMode | undefined {
  return value === "disabled" || value === "mention" || value === "open"
    ? value
    : undefined;
}

function normalizeOptionalConfigString(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export interface ChannelAccountSnapshot {
  [key: string]: unknown;
  channelId: string;
  accountId: string;
  displayName?: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  mode?: SlackChannelMode;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  config: ChannelProtocolConfig;
  hasToken?: boolean;
  hasBotToken?: boolean;
  hasAppToken?: boolean;
  groupMode?: TelegramGroupMode | WhatsAppGroupMode | SignalGroupMode;
  transcribeVoice?: boolean;
  richPrivateChatDefault?: boolean;
  richDraftStreaming?: boolean;
  binding?: {
    agentId: string | null;
    conversationId: string | null;
  };
  agentId?: string | null;
  defaultPermissionMode?: ChannelDefaultPermissionMode;
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  autoThreadOnMention?: boolean;
  threadPolicyByChannel?: Record<string, boolean>;
  acknowledgeMessageReaction?: boolean;
  listenMode?: boolean;
  removeStaleRoutes?: boolean;
  inboundDebounceMs?: number;
  selfChatMode?: boolean;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  recipientAliases?: Record<string, string>;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
  createdAt: string;
  updatedAt: string;
}

export type { ChannelAccountPatch, ChannelConfigPatch } from "./plugin-types";

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
    if (isTelegramChannelAccount(account)) {
      if (!account.token.trim()) {
        return undefined;
      }
      const info = await validateTelegramToken(account.token);
      return normalizeDisplayName(
        info.username ? `@${info.username}` : undefined,
      );
    }

    if (isDiscordChannelAccount(account)) {
      if (!account.token.trim()) {
        return undefined;
      }
      return normalizeDisplayName(
        await resolveDiscordAccountDisplayName(account.token),
      );
    }

    if (isSignalChannelAccount(account)) {
      return normalizeDisplayName(account.account ?? account.baseUrl);
    }

    if (!isSlackChannelAccount(account)) {
      return undefined;
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
  channelId: string,
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

async function getSelectedChannelAccountWithSecrets(
  channelId: string,
  accountId?: string,
): Promise<ChannelAccount | null> {
  const normalizedAccountId = accountId?.trim();
  if (normalizedAccountId) {
    return getChannelAccountWithSecrets(channelId, normalizedAccountId);
  }

  const accounts = await listChannelAccountsWithSecrets(channelId);
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

function isAccountConfigured(account: ChannelAccount): boolean {
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

function toAccountSnapshot(account: ChannelAccount): ChannelAccountSnapshot {
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
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function createAccountFromPatch(
  channelId: SupportedChannelId,
  accountId: string,
  patch: ChannelAccountPatch,
): ChannelAccount {
  const normalizedPatch = normalizeChannelAccountPatch(channelId, patch);
  const now = new Date().toISOString();
  if (channelId === "telegram") {
    return {
      channel: "telegram",
      accountId,
      displayName: normalizeDisplayName(normalizedPatch.displayName),
      enabled: normalizedPatch.enabled ?? false,
      token: normalizedPatch.token ?? "",
      dmPolicy: normalizedPatch.dmPolicy ?? "pairing",
      allowedUsers: normalizedPatch.allowedUsers ?? [],
      groupMode:
        normalizeTelegramGroupMode(normalizedPatch.groupMode) ?? "open",
      transcribeVoice: normalizedPatch.transcribeVoice === true,
      richPrivateChatDefault: normalizedPatch.richPrivateChatDefault ?? true,
      richDraftStreaming: normalizedPatch.richDraftStreaming === true,
      inboundDebounceMs: normalizedPatch.inboundDebounceMs,
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
      displayName: normalizeDisplayName(normalizedPatch.displayName),
      enabled: normalizedPatch.enabled ?? false,
      token: normalizedPatch.token ?? "",
      agentId: normalizedPatch.agentId ?? null,
      defaultPermissionMode:
        normalizedPatch.defaultPermissionMode ?? "standard",
      dmPolicy: normalizedPatch.dmPolicy ?? "pairing",
      allowedUsers: normalizedPatch.allowedUsers ?? [],
      allowedChannels: normalizedPatch.allowedChannels ?? [],
      autoThreadOnMention: normalizedPatch.autoThreadOnMention ?? false,
      threadPolicyByChannel: normalizedPatch.threadPolicyByChannel,
      acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction,
      removeStaleRoutes: normalizedPatch.removeStaleRoutes,
      inboundDebounceMs: normalizedPatch.inboundDebounceMs,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (channelId === "whatsapp") {
    return {
      channel: "whatsapp",
      accountId,
      displayName: normalizeDisplayName(normalizedPatch.displayName),
      enabled: normalizedPatch.enabled ?? false,
      agentId: normalizedPatch.agentId ?? null,
      dmPolicy: normalizedPatch.dmPolicy ?? "pairing",
      allowedUsers: normalizedPatch.allowedUsers ?? [],
      selfChatMode: normalizedPatch.selfChatMode ?? true,
      groupMode:
        normalizeWhatsAppGroupMode(normalizedPatch.groupMode) ?? "disabled",
      allowedGroups: normalizedPatch.allowedGroups ?? [],
      mentionPatterns: normalizedPatch.mentionPatterns ?? [],
      transcribeVoice: normalizedPatch.transcribeVoice === true,
      downloadMedia: normalizedPatch.downloadMedia === true,
      mediaMaxBytes: normalizedPatch.mediaMaxBytes,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (channelId === "signal") {
    return {
      channel: "signal",
      accountId,
      displayName: normalizeDisplayName(normalizedPatch.displayName),
      enabled: normalizedPatch.enabled ?? false,
      baseUrl: normalizedPatch.baseUrl ?? "",
      account: normalizeOptionalConfigString(normalizedPatch.account),
      accountUuid: normalizeOptionalConfigString(normalizedPatch.accountUuid),
      agentId: normalizedPatch.agentId ?? null,
      selfChatMode: normalizedPatch.selfChatMode === true,
      dmPolicy: normalizedPatch.dmPolicy ?? "pairing",
      allowedUsers: normalizedPatch.allowedUsers ?? [],
      groupMode:
        normalizeSignalGroupMode(normalizedPatch.groupMode) ?? "disabled",
      allowedGroups: normalizedPatch.allowedGroups ?? [],
      mentionPatterns: normalizedPatch.mentionPatterns ?? [],
      recipientAliases: normalizedPatch.recipientAliases ?? {},
      transcribeVoice: normalizedPatch.transcribeVoice === true,
      downloadMedia: normalizedPatch.downloadMedia ?? true,
      mediaMaxBytes: normalizedPatch.mediaMaxBytes,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (channelId !== "slack") {
    return {
      channel: channelId,
      accountId,
      displayName: normalizeDisplayName(normalizedPatch.displayName),
      enabled: normalizedPatch.enabled ?? false,
      dmPolicy: normalizedPatch.dmPolicy ?? "pairing",
      allowedUsers: normalizedPatch.allowedUsers ?? [],
      config: { ...(normalizedPatch.config ?? {}) },
      createdAt: now,
      updatedAt: now,
    } satisfies CustomChannelAccount;
  }

  return {
    channel: "slack",
    accountId,
    displayName: normalizeDisplayName(normalizedPatch.displayName),
    enabled: normalizedPatch.enabled ?? false,
    mode: normalizedPatch.mode ?? "socket",
    botToken: normalizedPatch.botToken ?? "",
    appToken: normalizedPatch.appToken ?? "",
    agentId: normalizedPatch.agentId ?? null,
    defaultPermissionMode:
      normalizedPatch.defaultPermissionMode ?? DEFAULT_SLACK_PERMISSION_MODE,
    transcribeVoice: normalizedPatch.transcribeVoice === true,
    listenMode: normalizedPatch.listenMode === true,
    dmPolicy: normalizedPatch.dmPolicy ?? "open",
    allowedUsers: normalizedPatch.allowedUsers ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

function mergeAccountPatch(
  existing: ChannelAccount,
  patch: ChannelAccountPatch,
): ChannelAccount {
  const normalizedPatch = normalizeChannelAccountPatch(existing.channel, patch);
  const nextUpdatedAt = new Date().toISOString();
  if (isTelegramChannelAccount(existing)) {
    return {
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      token: normalizedPatch.token ?? existing.token,
      dmPolicy: normalizedPatch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: normalizedPatch.allowedUsers ?? existing.allowedUsers,
      groupMode:
        normalizeTelegramGroupMode(normalizedPatch.groupMode) ??
        existing.groupMode ??
        "open",
      transcribeVoice:
        normalizedPatch.transcribeVoice ?? existing.transcribeVoice ?? false,
      richPrivateChatDefault:
        normalizedPatch.richPrivateChatDefault ??
        existing.richPrivateChatDefault ??
        true,
      richDraftStreaming:
        normalizedPatch.richDraftStreaming ??
        existing.richDraftStreaming ??
        false,
      inboundDebounceMs:
        normalizedPatch.inboundDebounceMs ?? existing.inboundDebounceMs,
      updatedAt: nextUpdatedAt,
    };
  }

  if (isDiscordChannelAccount(existing)) {
    return {
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      token: normalizedPatch.token ?? existing.token,
      agentId: normalizedPatch.agentId ?? existing.agentId,
      defaultPermissionMode:
        normalizedPatch.defaultPermissionMode ??
        existing.defaultPermissionMode ??
        "standard",
      dmPolicy: normalizedPatch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: normalizedPatch.allowedUsers ?? existing.allowedUsers,
      allowedChannels:
        normalizedPatch.allowedChannels ?? existing.allowedChannels,
      autoThreadOnMention:
        normalizedPatch.autoThreadOnMention ?? existing.autoThreadOnMention,
      threadPolicyByChannel:
        normalizedPatch.threadPolicyByChannel ?? existing.threadPolicyByChannel,
      acknowledgeMessageReaction:
        normalizedPatch.acknowledgeMessageReaction ??
        existing.acknowledgeMessageReaction,
      removeStaleRoutes:
        normalizedPatch.removeStaleRoutes ?? existing.removeStaleRoutes,
      inboundDebounceMs:
        normalizedPatch.inboundDebounceMs ?? existing.inboundDebounceMs,
      updatedAt: nextUpdatedAt,
    };
  }

  if (isWhatsAppChannelAccount(existing)) {
    return {
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      agentId: normalizedPatch.agentId ?? existing.agentId,
      dmPolicy: normalizedPatch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: normalizedPatch.allowedUsers ?? existing.allowedUsers,
      selfChatMode: normalizedPatch.selfChatMode ?? existing.selfChatMode,
      groupMode:
        normalizeWhatsAppGroupMode(normalizedPatch.groupMode) ??
        existing.groupMode,
      allowedGroups: normalizedPatch.allowedGroups ?? existing.allowedGroups,
      mentionPatterns:
        normalizedPatch.mentionPatterns ?? existing.mentionPatterns,
      transcribeVoice:
        normalizedPatch.transcribeVoice ?? existing.transcribeVoice ?? false,
      downloadMedia:
        normalizedPatch.downloadMedia ?? existing.downloadMedia ?? false,
      mediaMaxBytes: normalizedPatch.mediaMaxBytes ?? existing.mediaMaxBytes,
      updatedAt: nextUpdatedAt,
    };
  }

  if (isSignalChannelAccount(existing)) {
    return {
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      baseUrl: normalizedPatch.baseUrl ?? existing.baseUrl,
      account:
        normalizedPatch.account !== undefined
          ? normalizeOptionalConfigString(normalizedPatch.account)
          : existing.account,
      accountUuid:
        normalizedPatch.accountUuid !== undefined
          ? normalizeOptionalConfigString(normalizedPatch.accountUuid)
          : existing.accountUuid,
      agentId: normalizedPatch.agentId ?? existing.agentId,
      selfChatMode: normalizedPatch.selfChatMode ?? existing.selfChatMode,
      dmPolicy: normalizedPatch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: normalizedPatch.allowedUsers ?? existing.allowedUsers,
      groupMode:
        normalizeSignalGroupMode(normalizedPatch.groupMode) ??
        existing.groupMode,
      allowedGroups: normalizedPatch.allowedGroups ?? existing.allowedGroups,
      mentionPatterns:
        normalizedPatch.mentionPatterns ?? existing.mentionPatterns,
      recipientAliases:
        normalizedPatch.recipientAliases ?? existing.recipientAliases,
      transcribeVoice:
        normalizedPatch.transcribeVoice ?? existing.transcribeVoice ?? false,
      downloadMedia:
        normalizedPatch.downloadMedia ?? existing.downloadMedia ?? true,
      mediaMaxBytes: normalizedPatch.mediaMaxBytes ?? existing.mediaMaxBytes,
      updatedAt: nextUpdatedAt,
    };
  }

  if (!isSlackChannelAccount(existing)) {
    // Custom channels (and user-installed plugins) hold all plugin-specific
    // state in the generic `config` bag. Snapshots returned to clients redact
    // secrets (e.g. `bot_token` is replaced with `has_bot_token: boolean`), so
    // the client cannot send the secret back on every save. Merge the patch
    // into the existing config so omitted keys are preserved; pass `null`
    // explicitly to clear a key.
    return {
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      dmPolicy: normalizedPatch.dmPolicy ?? existing.dmPolicy,
      allowedUsers: normalizedPatch.allowedUsers ?? existing.allowedUsers,
      config:
        normalizedPatch.config !== undefined
          ? { ...existing.config, ...normalizedPatch.config }
          : { ...existing.config },
      updatedAt: nextUpdatedAt,
    };
  }

  return {
    ...existing,
    displayName:
      normalizedPatch.displayName !== undefined
        ? normalizeDisplayName(normalizedPatch.displayName)
        : existing.displayName,
    enabled: normalizedPatch.enabled ?? existing.enabled,
    mode: normalizedPatch.mode ?? existing.mode,
    botToken: normalizedPatch.botToken ?? existing.botToken,
    appToken: normalizedPatch.appToken ?? existing.appToken,
    agentId: normalizedPatch.agentId ?? existing.agentId,
    defaultPermissionMode:
      normalizedPatch.defaultPermissionMode ??
      existing.defaultPermissionMode ??
      DEFAULT_SLACK_PERMISSION_MODE,
    transcribeVoice:
      normalizedPatch.transcribeVoice ?? existing.transcribeVoice ?? false,
    listenMode: normalizedPatch.listenMode ?? existing.listenMode ?? false,
    dmPolicy: normalizedPatch.dmPolicy ?? existing.dmPolicy,
    allowedUsers: normalizedPatch.allowedUsers ?? existing.allowedUsers,
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

export async function setChannelConfigLive(
  channelId: string,
  patch: ChannelConfigPatch,
  accountId?: string,
): Promise<ChannelConfigSnapshot> {
  assertSupportedChannelId(channelId);
  const normalizedPatch = normalizeChannelConfigPatch(channelId, patch);
  const existing = await getSelectedChannelAccountWithSecrets(
    channelId,
    accountId,
  );
  let targetAccountId = existing?.accountId;
  let shouldRefreshDisplayName = false;
  if (existing) {
    await updateChannelAccountLiveWithSecrets(channelId, existing.accountId, {
      enabled: existing.enabled,
      token: normalizedPatch.token,
      botToken: normalizedPatch.botToken,
      appToken: normalizedPatch.appToken,
      mode: normalizedPatch.mode,
      defaultPermissionMode: normalizedPatch.defaultPermissionMode,
      dmPolicy: normalizedPatch.dmPolicy,
      allowedUsers: normalizedPatch.allowedUsers,
      allowedChannels: normalizedPatch.allowedChannels,
      agentId: normalizedPatch.agentId,
      autoThreadOnMention: normalizedPatch.autoThreadOnMention,
      threadPolicyByChannel: normalizedPatch.threadPolicyByChannel,
      acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction,
      listenMode: normalizedPatch.listenMode,
      removeStaleRoutes: normalizedPatch.removeStaleRoutes,
      inboundDebounceMs: normalizedPatch.inboundDebounceMs,
      selfChatMode: normalizedPatch.selfChatMode,
      baseUrl: normalizedPatch.baseUrl,
      account: normalizedPatch.account,
      accountUuid: normalizedPatch.accountUuid,
      groupMode: normalizedPatch.groupMode,
      allowedGroups: normalizedPatch.allowedGroups,
      mentionPatterns: normalizedPatch.mentionPatterns,
      transcribeVoice: normalizedPatch.transcribeVoice,
      richPrivateChatDefault: normalizedPatch.richPrivateChatDefault,
      richDraftStreaming: normalizedPatch.richDraftStreaming,
      downloadMedia: normalizedPatch.downloadMedia,
      mediaMaxBytes: normalizedPatch.mediaMaxBytes,
      config: normalizedPatch.config,
      displayName: existing.displayName,
    });
    shouldRefreshDisplayName = channelPluginConfigShouldRefreshDisplayName(
      channelId,
      normalizedPatch,
    );
  } else {
    const created = await createChannelAccountLiveWithSecrets(
      channelId,
      {
        enabled: false,
        token: normalizedPatch.token,
        botToken: normalizedPatch.botToken,
        appToken: normalizedPatch.appToken,
        mode: normalizedPatch.mode,
        defaultPermissionMode: normalizedPatch.defaultPermissionMode,
        dmPolicy: normalizedPatch.dmPolicy,
        allowedUsers: normalizedPatch.allowedUsers,
        allowedChannels: normalizedPatch.allowedChannels,
        agentId: normalizedPatch.agentId,
        autoThreadOnMention: normalizedPatch.autoThreadOnMention,
        threadPolicyByChannel: normalizedPatch.threadPolicyByChannel,
        acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction,
        listenMode: normalizedPatch.listenMode,
        removeStaleRoutes: normalizedPatch.removeStaleRoutes,
        inboundDebounceMs: normalizedPatch.inboundDebounceMs,
        selfChatMode: normalizedPatch.selfChatMode,
        baseUrl: normalizedPatch.baseUrl,
        account: normalizedPatch.account,
        accountUuid: normalizedPatch.accountUuid,
        groupMode: normalizedPatch.groupMode,
        allowedGroups: normalizedPatch.allowedGroups,
        mentionPatterns: normalizedPatch.mentionPatterns,
        transcribeVoice: normalizedPatch.transcribeVoice,
        richPrivateChatDefault: normalizedPatch.richPrivateChatDefault,
        richDraftStreaming: normalizedPatch.richDraftStreaming,
        downloadMedia: normalizedPatch.downloadMedia,
        mediaMaxBytes: normalizedPatch.mediaMaxBytes,
        config: normalizedPatch.config,
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
    ((await getChannelAccountWithSecrets(channelId, targetAccountId))
      ?.enabled ?? false) === true
  ) {
    await ensureChannelRegistry().startChannelAccount(
      channelId,
      targetAccountId,
    );
  }

  const snapshot = await getChannelConfigSnapshotWithSecrets(
    channelId,
    targetAccountId,
  );
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

  const existing = await getSelectedChannelAccountWithSecrets(
    channelId,
    accountId,
  );
  if (!existing) {
    throw new Error(
      `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }
  if (!isAccountConfigured(existing)) {
    if (isTelegramChannelAccount(existing)) {
      throw new Error(
        'Channel "telegram" is missing a token. Configure it first.',
      );
    }
    if (isDiscordChannelAccount(existing)) {
      throw new Error(
        'Channel "discord" is missing a token. Configure it first.',
      );
    }
    if (!isSlackChannelAccount(existing)) {
      throw new Error(
        `Channel "${channelId}" account is not configured. Configure it first.`,
      );
    }
    throw new Error(
      'Channel "slack" is missing a bot token or app token. Configure it first.',
    );
  }

  if (!existing.enabled) {
    await upsertChannelAccountWithSecrets(channelId, {
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

  const existing = await getSelectedChannelAccountWithSecrets(
    channelId,
    accountId,
  );
  if (!existing) {
    throw new Error(
      `Channel "${channelId}" is not configured. Configure it first.`,
    );
  }

  await upsertChannelAccountWithSecrets(channelId, {
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
    upsertChannelAccount(channelId, {
      ...existing,
      enabled: false,
      updatedAt: new Date().toISOString(),
    });
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

export function __testOverrideResolveChannelAccountDisplayName(
  fn:
    | ((
        account: ChannelAccount,
      ) => Promise<string | undefined> | string | undefined)
    | null,
): void {
  resolveChannelAccountDisplayNameOverride = fn;
}
