import type { ChannelProtocolConfig } from "./plugin-types";
import type {
  ChannelDefaultPermissionMode,
  DiscordChannelMode,
  DmPolicy,
  SignalGroupMode,
  SlackAllowBotsMode,
  SlackChannelMode,
  TelegramGroupMode,
  WhatsAppGroupMode,
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
  allowBots?: SlackAllowBotsMode;
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
  allowBots?: SlackAllowBotsMode;
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
