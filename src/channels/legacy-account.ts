import { readChannelConfig } from "./config";
import type { ChannelAccount, SupportedChannelId } from "./types";
import { DEFAULT_SLACK_PERMISSION_MODE } from "./types";

export function makeDefaultLegacyAccount(
  channelId: SupportedChannelId,
  accountId: string,
): ChannelAccount {
  const config = readChannelConfig(channelId);
  const now = new Date().toISOString();

  if (!config) {
    throw new Error(`Missing legacy config for ${channelId}`);
  }

  if (config.channel === "telegram") {
    return {
      channel: "telegram",
      accountId,
      enabled: config.enabled,
      token: config.token,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      transcribeVoice: config.transcribeVoice === true,
      richPrivateChatDefault: config.richPrivateChatDefault !== false,
      richDraftStreaming: config.richDraftStreaming === true,
      binding: {
        agentId: null,
        conversationId: null,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  if (config.channel === "discord") {
    return {
      channel: "discord",
      accountId,
      enabled: config.enabled,
      token: config.token,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      allowedChannels: config.allowedChannels
        ? Array.isArray(config.allowedChannels)
          ? [...config.allowedChannels]
          : { ...config.allowedChannels }
        : undefined,
      autoThreadOnMention: config.autoThreadOnMention ?? true,
      threadPolicyByChannel: config.threadPolicyByChannel,
      agentId: null,
      defaultPermissionMode: config.defaultPermissionMode ?? "standard",
      createdAt: now,
      updatedAt: now,
    };
  }

  if (config.channel === "whatsapp") {
    return {
      channel: "whatsapp",
      accountId,
      enabled: config.enabled,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      agentId: config.agentId,
      selfChatMode: config.selfChatMode !== false,
      groupMode: config.groupMode ?? "disabled",
      allowedGroups: config.allowedGroups ? [...config.allowedGroups] : [],
      mentionPatterns: config.mentionPatterns
        ? [...config.mentionPatterns]
        : [],
      transcribeVoice: config.transcribeVoice === true,
      downloadMedia: config.downloadMedia === true,
      mediaMaxBytes: config.mediaMaxBytes,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (config.channel === "signal") {
    return {
      channel: "signal",
      accountId,
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      account: config.account,
      accountUuid: config.accountUuid,
      dmPolicy: config.dmPolicy,
      allowedUsers: [...config.allowedUsers],
      agentId: config.agentId,
      selfChatMode: config.selfChatMode === true,
      groupMode: config.groupMode ?? "disabled",
      allowedGroups: config.allowedGroups ? [...config.allowedGroups] : [],
      mentionPatterns: config.mentionPatterns
        ? [...config.mentionPatterns]
        : [],
      recipientAliases: { ...(config.recipientAliases ?? {}) },
      downloadMedia: config.downloadMedia !== false,
      mediaMaxBytes: config.mediaMaxBytes,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    channel: "slack",
    accountId,
    enabled: config.enabled,
    mode: config.mode,
    botToken: config.botToken,
    appToken: config.appToken,
    dmPolicy: config.dmPolicy,
    allowedUsers: [...config.allowedUsers],
    agentId: null,
    defaultPermissionMode: DEFAULT_SLACK_PERMISSION_MODE,
    transcribeVoice: config.transcribeVoice === true,
    listenMode: config.listenMode === true,
    allowBots: config.allowBots ?? false,
    createdAt: now,
    updatedAt: now,
  };
}
