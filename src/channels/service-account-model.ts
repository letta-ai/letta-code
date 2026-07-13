import { normalizeChannelAccountPatch } from "./account-config";
import {
  assertAccountHasRequiredCredentials,
  assertEnabledAccountPatchHasRequiredCredentials,
  getConfigSecretKeys,
  getPersistedSecretRefPaths,
  mergeCredentialPatchValue,
} from "./credential-utils";
import type {
  ChannelAccountPatch,
  ChannelProtocolConfig,
} from "./plugin-types";
import { normalizeDisplayName } from "./service-shared";
import type {
  ChannelAccount,
  CustomChannelAccount,
  SignalGroupMode,
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

function assertEnabledAccountHasRequiredCredentials<T extends ChannelAccount>(
  account: T,
): T {
  if (account.enabled) {
    assertAccountHasRequiredCredentials(account);
  }
  return account;
}

function mergePluginConfigPatch(
  existing: CustomChannelAccount,
  patch: ChannelProtocolConfig | undefined,
): ChannelProtocolConfig {
  if (patch === undefined) {
    return { ...existing.config };
  }

  const secretKeys = getConfigSecretKeys(
    existing.channel,
    getPersistedSecretRefPaths(existing),
  );
  const nextConfig: ChannelProtocolConfig = { ...existing.config };
  for (const [key, value] of Object.entries(patch)) {
    if (secretKeys.has(key) && typeof value === "string") {
      const existingValue = existing.config[key];
      nextConfig[key] = mergeCredentialPatchValue(
        typeof existingValue === "string" ? existingValue : "",
        value,
      );
      continue;
    }
    nextConfig[key] = value;
  }
  return nextConfig;
}

export function createAccountFromPatch(
  channelId: SupportedChannelId,
  accountId: string,
  patch: ChannelAccountPatch,
): ChannelAccount {
  const normalizedPatch = normalizeChannelAccountPatch(channelId, patch);
  assertEnabledAccountPatchHasRequiredCredentials(channelId, normalizedPatch);
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

export function mergeAccountPatch(
  existing: ChannelAccount,
  patch: ChannelAccountPatch,
): ChannelAccount {
  const normalizedPatch = normalizeChannelAccountPatch(existing.channel, patch);
  const nextUpdatedAt = new Date().toISOString();
  if (isTelegramChannelAccount(existing)) {
    return assertEnabledAccountHasRequiredCredentials({
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      token: mergeCredentialPatchValue(existing.token, normalizedPatch.token),
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
    });
  }

  if (isDiscordChannelAccount(existing)) {
    return assertEnabledAccountHasRequiredCredentials({
      ...existing,
      displayName:
        normalizedPatch.displayName !== undefined
          ? normalizeDisplayName(normalizedPatch.displayName)
          : existing.displayName,
      enabled: normalizedPatch.enabled ?? existing.enabled,
      token: mergeCredentialPatchValue(existing.token, normalizedPatch.token),
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
    });
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
      config: mergePluginConfigPatch(existing, normalizedPatch.config),
      updatedAt: nextUpdatedAt,
    };
  }

  return assertEnabledAccountHasRequiredCredentials({
    ...existing,
    displayName:
      normalizedPatch.displayName !== undefined
        ? normalizeDisplayName(normalizedPatch.displayName)
        : existing.displayName,
    enabled: normalizedPatch.enabled ?? existing.enabled,
    mode: normalizedPatch.mode ?? existing.mode,
    botToken: mergeCredentialPatchValue(
      existing.botToken,
      normalizedPatch.botToken,
    ),
    appToken: mergeCredentialPatchValue(
      existing.appToken,
      normalizedPatch.appToken,
    ),
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
  });
}
