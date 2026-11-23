import type { ChannelUserMention } from "@/channels/message-references";
import type { WhatsAppMessagePrefixConfig } from "@/channels/whatsapp/message-prefix-config-types";
import type { PermissionMode } from "@/permissions/mode";
import type {
  ApprovalResponseBody,
  ListModelsResponseModelEntry,
  StopReasonType,
} from "@/types/protocol_v2";
import type { ChannelTurnProgressUpdate } from "./progress-types";
import type { WhatsAppAttachmentPolicyConfig } from "./whatsapp/attachment-policy-types";
import type { WhatsAppWaitingBehavior } from "./whatsapp/waiting-behavior-config-types";

export type {
  ChannelTurnProgressKind,
  ChannelTurnProgressState,
  ChannelTurnProgressUpdate,
} from "./progress-types";
export type ChannelModelPickerData = {
  current: {
    modelLabel: string;
    modelHandle: string | null;
    scope?: "agent" | "conversation";
  };
  entries: ListModelsResponseModelEntry[];
  availableHandles?: string[] | null;
  recentHandles?: string[];
};
export const LEGACY_DEFAULT_CHANNEL_ID = "telegram";
export type ChannelRichDraftStreamingPolicy = {
  richPrivateChatDefault: boolean;
};
export function getRichDraftStreamingPolicy(
  account: unknown,
): ChannelRichDraftStreamingPolicy | null {
  if (!account || typeof account !== "object") {
    return null;
  }
  const record = account as {
    richDraftStreaming?: unknown;
    richPrivateChatDefault?: unknown;
  };
  if (record.richDraftStreaming !== true) {
    return null;
  }
  return { richPrivateChatDefault: record.richPrivateChatDefault !== false };
}

export const FIRST_PARTY_CHANNEL_IDS = [
  "telegram",
  "slack",
  "discord",
  "custom",
  "whatsapp",
  "signal",
] as const;
export type FirstPartyChannelId = (typeof FIRST_PARTY_CHANNEL_IDS)[number];
export const SUPPORTED_CHANNEL_IDS = FIRST_PARTY_CHANNEL_IDS;
export type SupportedChannelId = string;
export type ChannelChatType = "direct" | "channel";
export type ChannelDefaultPermissionMode = Extract<
  PermissionMode,
  "standard" | "acceptEdits" | "unrestricted"
>;
export type SlackDefaultPermissionMode = ChannelDefaultPermissionMode;
export type DiscordDefaultPermissionMode = ChannelDefaultPermissionMode;

export const DEFAULT_SLACK_PERMISSION_MODE: SlackDefaultPermissionMode =
  "unrestricted";

export type DiscordChannelMode = "open" | "mention-only";

export interface ChannelMessageAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: "image" | "file" | "audio" | "video";
  localPath?: string;
  sourceMessageId?: string;
  sourceThreadId?: string | null;
  downloadReason?:
    | "exceeds_auto_download_limit"
    | "missing_download_url"
    | "download_failed";
  autoDownloadLimitBytes?: number;
  imageDataBase64?: string;
  transcription?: string;
  transcriptionError?: string;
}
export interface ChannelReactionNotification {
  action: "added" | "removed";
  emoji: string;
  targetMessageId: string;
  targetSenderId?: string;
}
export interface ChannelThreadContextEntry {
  messageId?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  userMentions?: ChannelUserMention[];
  attachments?: ChannelMessageAttachment[];
}
export interface ChannelThreadContext {
  label?: string;
  starter?: ChannelThreadContextEntry;
  history?: ChannelThreadContextEntry[];
}
export interface ChannelReplyContext {
  messageId?: string;
  senderId?: string;
  senderName?: string;
  text?: string;
  userMentions?: ChannelUserMention[];
}

export interface ChannelTurnSource {
  channel: string;
  accountId?: string;
  chatId: string;
  chatType?: ChannelChatType;
  senderId?: string;
  senderTeamId?: string;
  showStartupStatus?: boolean;
  messageId?: string;
  threadId?: string | null;
  agentId: string;
  conversationId: string;
}

export type ChannelTurnOutcome = "completed" | "error" | "cancelled";

export interface ChannelTurnProgressEvent extends ChannelTurnProgressUpdate {
  type: "progress";
  batchId?: string;
  sources: ChannelTurnSource[];
}

export type ChannelControlRequestKind =
  | "ask_user_question"
  | "generic_tool_approval";

export interface ChannelControlRequestEvent {
  requestId: string;
  kind: ChannelControlRequestKind;
  source: ChannelTurnSource;
  toolName: string;
  input: Record<string, unknown>;
}

export type ChannelControlResponseResult =
  | "handled"
  | "expired"
  | "unavailable"
  | "forbidden";

export interface ChannelControlResponseInput {
  requestId: string;
  response: ApprovalResponseBody;
  senderId: string;
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string | null;
}

export type ChannelTurnLifecycleEvent =
  | {
      type: "queued";
      source: ChannelTurnSource;
    }
  | {
      type: "processing";
      batchId: string;
      sources: ChannelTurnSource[];
    }
  | {
      type: "finished";
      batchId: string;
      sources: ChannelTurnSource[];
      outcome: ChannelTurnOutcome;
      stopReason: StopReasonType;
      remainingSources?: ChannelTurnSource[];
      error?: string;
      runId?: string;
    };

export type ChannelStartupLogger = (message: string) => void;

export interface ChannelAdapterStartOptions {
  logger?: ChannelStartupLogger;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly channelId?: string;
  readonly accountId?: string;
  readonly name: string;

  start(options?: ChannelAdapterStartOptions): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  sendMessage(msg: OutboundChannelMessage): Promise<{ messageId: string }>;
  listCustomEmojis?(): Promise<string[]>;
  downloadAttachment?(params: {
    attachmentId: string;
    chatId: string;
    threadId?: string | null;
    messageId: string;
    signal?: AbortSignal;
  }): Promise<ChannelMessageAttachment>;

  sendRichMessageDraft?(draft: OutboundChannelRichMessageDraft): Promise<void>;

  sendDirectReply(
    chatId: string,
    text: string,
    options?: {
      replyToMessageId?: string;
      threadId?: string | null;
      modelPicker?: ChannelModelPickerData;
      applyMessagePrefix?: boolean;
    },
  ): Promise<void>;

  prepareInboundMessage?(
    msg: InboundChannelMessage,
    options?: { isFirstRouteTurn?: boolean },
  ): Promise<InboundChannelMessage>;

  handleTurnLifecycleEvent?(event: ChannelTurnLifecycleEvent): Promise<void>;

  handleTurnProgressEvent?(event: ChannelTurnProgressEvent): Promise<void>;

  handleControlRequestEvent?(event: ChannelControlRequestEvent): Promise<void>;

  onControlResponse?: (
    input: ChannelControlResponseInput,
  ) => Promise<ChannelControlResponseResult>;

  onMessage?: (msg: InboundChannelMessage) => Promise<void>;
}

export interface InboundChannelMessage {
  channel: string;
  accountId?: string;
  chatId: string;
  senderId: string;
  senderTeamId?: string;
  senderName?: string;
  chatLabel?: string;
  text: string;
  userMentions?: ChannelUserMention[];
  timestamp: number;
  messageId?: string;
  threadId?: string | null;
  raw?: unknown;
  chatType?: ChannelChatType;
  isMention?: boolean;
  routedBy?: "mention" | "dm" | "thread";
  isOpenChannel?: boolean;
  parentChannelId?: string;
  attachments?: ChannelMessageAttachment[];
  reaction?: ChannelReactionNotification;
  replyContext?: ChannelReplyContext;
  threadContext?: ChannelThreadContext;
}

export interface ChannelRichMessage {
  html?: string;
  markdown?: string;
  isRtl?: boolean;
  skipEntityDetection?: boolean;
}

export interface OutboundChannelMessage {
  channel: string;
  accountId?: string;
  chatId: string;
  text: string;
  replyToMessageId?: string;
  threadId?: string | null;
  parseMode?: string;
  richMessage?: ChannelRichMessage;
  textStyle?: string[];
  mediaPath?: string;
  fileName?: string;
  title?: string;
  reaction?: string;
  removeReaction?: boolean;
  targetMessageId?: string;
  agentId?: string;
  conversationId?: string;
}

export interface OutboundChannelRichMessageDraft {
  channel: string;
  accountId?: string;
  chatId: string;
  threadId?: string | null;
  draftId: number;
  richMessage: ChannelRichMessage;
}

export interface ChannelRoute {
  accountId?: string;
  chatId: string;
  chatType?: ChannelChatType;
  threadId?: string | null;
  agentId: string;
  conversationId: string;
  enabled: boolean;
  outboundEnabled?: boolean;
  detached?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export type DmPolicy = "pairing" | "allowlist" | "open";
export type ChannelGroupSenderPolicy = "open" | "allowlist";
export type SlackChannelMode = "socket";
export type ChannelAllowBotsMode = false | "mentions";
export type SlackAllowBotsMode = ChannelAllowBotsMode;
export type DiscordAllowBotsMode = ChannelAllowBotsMode;
export type TelegramGroupMode = "open" | "mention-only";
export type WhatsAppGroupMode = "disabled" | "mention" | "open";
export type SignalGroupMode = "disabled" | "mention" | "open";

export interface ChannelAccountBinding {
  agentId: string | null;
  conversationId: string | null;
}

interface ChannelAccountBase {
  accountId: string;
  displayName?: string;
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  groupPolicy?: ChannelGroupSenderPolicy;
  adminUsers?: string[];
  userAllowedCommands?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomChannelAccount extends ChannelAccountBase {
  channel: string;
  config: Record<string, unknown>;
}

export interface TelegramChannelConfig {
  channel: "telegram";
  enabled: boolean;
  token: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  groupMode?: TelegramGroupMode;
  transcribeVoice?: boolean;
  richPrivateChatDefault?: boolean;
  richDraftStreaming?: boolean;
}

export interface SlackChannelConfig {
  channel: "slack";
  enabled: boolean;
  mode: SlackChannelMode;
  botToken: string;
  appToken: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  transcribeVoice?: boolean;
  listenMode?: boolean;
  mentionOnlyChannels?: string[];
  allowBots?: SlackAllowBotsMode;
}

export interface DiscordChannelConfig {
  channel: "discord";
  enabled: boolean;
  token: string;
  defaultPermissionMode: DiscordDefaultPermissionMode;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  autoThreadOnMention?: boolean;
  threadPolicyByChannel?: Record<string, boolean>;
  acknowledgeMessageReaction?: boolean;
  removeStaleRoutes?: boolean;
  inboundDebounceMs?: number;
  allowBots?: DiscordAllowBotsMode;
}

export interface WhatsAppChannelConfig
  extends WhatsAppAttachmentPolicyConfig,
    WhatsAppMessagePrefixConfig {
  channel: "whatsapp";
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  agentId: string | null;
  selfChatMode: boolean;
  groupMode: WhatsAppGroupMode;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  transcribeVoice?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
  inboundDebounceMs?: number;
  waitingBehavior?: WhatsAppWaitingBehavior;
}

export interface SignalChannelConfig {
  channel: "signal";
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  baseUrl: string;
  account?: string;
  accountUuid?: string;
  agentId: string | null;
  selfChatMode: boolean;
  groupMode: SignalGroupMode;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  recipientAliases?: Record<string, string>;
  transcribeVoice?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
}

export type ChannelConfig =
  | TelegramChannelConfig
  | SlackChannelConfig
  | DiscordChannelConfig
  | WhatsAppChannelConfig
  | SignalChannelConfig;

export interface TelegramChannelAccount extends ChannelAccountBase {
  channel: "telegram";
  token: string;
  binding: ChannelAccountBinding;
  groupMode?: TelegramGroupMode;
  transcribeVoice?: boolean;
  richPrivateChatDefault?: boolean;
  richDraftStreaming?: boolean;
  inboundDebounceMs?: number;
}

export interface SlackChannelAccount extends ChannelAccountBase {
  channel: "slack";
  mode: SlackChannelMode;
  botToken: string;
  appToken: string;
  agentId: string | null;
  defaultPermissionMode: SlackDefaultPermissionMode;
  transcribeVoice?: boolean;
  listenMode?: boolean;
  mentionOnlyChannels?: string[];
  allowBots?: SlackAllowBotsMode;
  inboundDebounceMs?: number;
}
export interface DiscordChannelAccount extends ChannelAccountBase {
  channel: "discord";
  token: string;
  transcribeVoice?: boolean;
  agentId: string | null;
  defaultPermissionMode: DiscordDefaultPermissionMode;
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  autoThreadOnMention?: boolean;
  threadPolicyByChannel?: Record<string, boolean>;
  acknowledgeMessageReaction?: boolean;
  removeStaleRoutes?: boolean;
  inboundDebounceMs?: number;
  allowBots?: DiscordAllowBotsMode;
}

export interface WhatsAppChannelAccount
  extends ChannelAccountBase,
    WhatsAppAttachmentPolicyConfig,
    WhatsAppMessagePrefixConfig {
  channel: "whatsapp";
  agentId: string | null;
  selfChatMode: boolean;
  groupMode: WhatsAppGroupMode;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  transcribeVoice?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
  inboundDebounceMs?: number;
  waitingBehavior?: WhatsAppWaitingBehavior;
}

export interface SignalChannelAccount extends ChannelAccountBase {
  channel: "signal";
  baseUrl: string;
  account?: string;
  accountUuid?: string;
  agentId: string | null;
  selfChatMode: boolean;
  groupMode: SignalGroupMode;
  allowedGroups?: string[];
  mentionPatterns?: string[];
  recipientAliases?: Record<string, string>;
  transcribeVoice?: boolean;
  downloadMedia?: boolean;
  mediaMaxBytes?: number;
}

export type ChannelAccount =
  | TelegramChannelAccount
  | SlackChannelAccount
  | DiscordChannelAccount
  | WhatsAppChannelAccount
  | SignalChannelAccount
  | CustomChannelAccount;

export function isFirstPartyChannelId(
  channelId: string,
): channelId is FirstPartyChannelId {
  return FIRST_PARTY_CHANNEL_IDS.includes(channelId as FirstPartyChannelId);
}

export function isTelegramChannelAccount(
  account: ChannelAccount,
): account is TelegramChannelAccount {
  return (
    account.channel === "telegram" && "token" in account && "binding" in account
  );
}

export function isSlackChannelAccount(
  account: ChannelAccount,
): account is SlackChannelAccount {
  return (
    account.channel === "slack" &&
    "botToken" in account &&
    "appToken" in account
  );
}

export function isDiscordChannelAccount(
  account: ChannelAccount,
): account is DiscordChannelAccount {
  return account.channel === "discord" && "token" in account;
}

export function isWhatsAppChannelAccount(
  account: ChannelAccount,
): account is WhatsAppChannelAccount {
  return account.channel === "whatsapp" && "selfChatMode" in account;
}

export function isSignalChannelAccount(
  account: ChannelAccount,
): account is SignalChannelAccount {
  return account.channel === "signal" && "baseUrl" in account;
}

export function isCustomChannelAccount(
  account: ChannelAccount,
): account is CustomChannelAccount {
  if (account.channel === "custom") {
    return "config" in account;
  }
  return !isFirstPartyChannelId(account.channel) && "config" in account;
}

export interface PendingPairing {
  accountId?: string;
  code: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovedUser {
  accountId?: string;
  senderId: string;
  senderName?: string;
  approvedAt: string;
}

export interface PairingStore {
  pending: PendingPairing[];
  approved: ApprovedUser[];
}

export interface ChannelBindableTarget {
  accountId?: string;
  targetId: string;
  targetType: "channel";
  chatId: string;
  label: string;
  discoveredAt: string;
  lastSeenAt: string;
  lastMessageId?: string;
}
