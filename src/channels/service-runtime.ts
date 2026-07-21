import {
  channelPluginConfigShouldRefreshDisplayName,
  normalizeChannelConfigPatch,
} from "./account-config";
import {
  getChannelAccountWithSecrets,
  upsertChannelAccountWithSecrets,
} from "./accounts";
import type { ChannelConfigPatch } from "./plugin-types";
import { ensureChannelRegistry, getChannelRegistry } from "./registry";
import {
  createChannelAccountLiveWithSecrets,
  refreshChannelAccountDisplayNameLive,
  updateChannelAccountLiveWithSecrets,
} from "./service-accounts";
import {
  assertSupportedChannelId,
  getSelectedChannelAccountWithSecrets,
  refreshLoadedMessageChannelTool,
} from "./service-shared";
import {
  getChannelConfigSnapshotWithSecrets,
  isAccountConfigured,
  listChannelSummaries,
} from "./service-snapshots";
import type { ChannelConfigSnapshot, ChannelSummary } from "./service-types";
import {
  isDiscordChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
} from "./types";

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
      allowBots: normalizedPatch.allowBots,
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
        allowBots: normalizedPatch.allowBots,
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
