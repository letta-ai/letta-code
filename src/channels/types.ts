/**
 * Channel system types.
 *
 * A "channel" connects Letta Code agents to external messaging platforms
 * (Telegram, Slack, etc.). Each channel has an adapter that handles
 * platform-specific communication, and a routing table that maps
 * platform chat IDs to agent+conversation pairs.
 */

export const SUPPORTED_CHANNEL_IDS = ["telegram", "slack"] as const;
export type SupportedChannelId = (typeof SUPPORTED_CHANNEL_IDS)[number];
export type ChannelChatType = "direct" | "channel";

export interface ChannelMessageAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: "image" | "file" | "audio" | "video";
  localPath: string;
  imageDataBase64?: string;
}

export interface ChannelReactionNotification {
  action: "added" | "removed";
  emoji: string;
  targetMessageId: string;
  targetSenderId?: string;
}

// ── Adapter interface ─────────────────────────────────────────────

export interface ChannelAdapter {
  /** Platform identifier, e.g. "telegram", "slack". */
  readonly id: string;
  /** Channel identifier, e.g. "telegram". */
  readonly channelId?: SupportedChannelId;
  /** Account identifier within the channel. */
  readonly accountId?: string;
  /** Human-readable display name, e.g. "Telegram". */
  readonly name: string;

  /** Start receiving messages (e.g. begin long-polling). */
  start(): Promise<void>;
  /** Stop receiving messages gracefully. */
  stop(): Promise<void>;
  /** Whether the adapter is currently running. */
  isRunning(): boolean;

  /** Send a message through this channel. */
  sendMessage(msg: OutboundChannelMessage): Promise<{ messageId: string }>;

  /**
   * Send a direct reply on the platform (for pairing codes, no-route
   * messages, etc.) without going through the agent.
   */
  sendDirectReply(
    chatId: string,
    text: string,
    options?: { replyToMessageId?: string },
  ): Promise<void>;

  /**
   * Called by the registry when the adapter receives an inbound message.
   * Set by ChannelRegistry during initialization.
   */
  onMessage?: (msg: InboundChannelMessage) => Promise<void>;
}

// ── Message types ─────────────────────────────────────────────────

export interface InboundChannelMessage {
  /** Platform identifier, e.g. "telegram". */
  channel: string;
  /** Channel account that received the inbound message. */
  accountId?: string;
  /** Platform-specific chat/conversation ID. */
  chatId: string;
  /** Platform-specific sender user ID. */
  senderId: string;
  /** Sender display name, if available. */
  senderName?: string;
  /** Chat/channel label, if available (for discovery UIs). */
  chatLabel?: string;
  /** Message text content. */
  text: string;
  /** Unix timestamp (ms) of the message. */
  timestamp: number;
  /** Platform message ID for threading/replies. */
  messageId?: string;
  /** Canonical thread identifier used for route selection, when applicable. */
  threadId?: string | null;
  /** Raw platform-specific event data for future use. */
  raw?: unknown;
  /** Broad chat surface type used for routing/pairing decisions. */
  chatType?: ChannelChatType;
  /** Whether this inbound message was explicitly addressed to the bot. */
  isMention?: boolean;
  /** Downloaded attachments/media associated with the inbound message. */
  attachments?: ChannelMessageAttachment[];
  /** Reaction metadata for non-text channel events. */
  reaction?: ChannelReactionNotification;
}

export interface OutboundChannelMessage {
  /** Platform identifier. */
  channel: string;
  /** Channel account that should send the outbound message. */
  accountId?: string;
  /** Target chat/conversation ID. */
  chatId: string;
  /** Message text to send. */
  text: string;
  /** Optional: reply to a specific message. */
  replyToMessageId?: string;
  /** Optional: canonical thread identifier used for threaded channels. */
  threadId?: string | null;
  /** Optional: parse mode hint for the adapter (e.g. "HTML", "MarkdownV2"). */
  parseMode?: string;
  /** Optional: attach a local file/media path for channels that support uploads. */
  mediaPath?: string;
  /** Optional: override the uploaded filename for media attachments. */
  fileName?: string;
  /** Optional: override the uploaded title/caption metadata for media attachments. */
  title?: string;
  /** Optional: reaction emoji to add/remove. Slack uses names; Telegram uses native emoji or custom_emoji:<id>. */
  reaction?: string;
  /** Optional: remove the channel reaction instead of adding it. */
  removeReaction?: boolean;
  /** Optional: target message id for reactions. */
  targetMessageId?: string;
}

// ── Routing ───────────────────────────────────────────────────────

export interface ChannelRoute {
  /** Channel account identifier. */
  accountId?: string;
  /** Platform-specific chat ID. */
  chatId: string;
  /** Broad chat surface type for this route. */
  chatType?: ChannelChatType;
  /** Canonical thread identifier for threaded channels, if any. */
  threadId?: string | null;
  /** Letta agent ID this chat is bound to. */
  agentId: string;
  /** Letta conversation ID this chat is bound to. */
  conversationId: string;
  /** Whether this route is active. */
  enabled: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 update timestamp. */
  updatedAt?: string;
}

// ── Config ────────────────────────────────────────────────────────

export type DmPolicy = "pairing" | "allowlist" | "open";
export type SlackChannelMode = "socket";

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
  createdAt: string;
  updatedAt: string;
}

export interface TelegramChannelConfig {
  channel: "telegram";
  enabled: boolean;
  token: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
}

export interface SlackChannelConfig {
  channel: "slack";
  enabled: boolean;
  mode: SlackChannelMode;
  botToken: string;
  appToken: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
}

export type ChannelConfig = TelegramChannelConfig | SlackChannelConfig;

export interface TelegramChannelAccount extends ChannelAccountBase {
  channel: "telegram";
  token: string;
  binding: ChannelAccountBinding;
}

export interface SlackChannelAccount extends ChannelAccountBase {
  channel: "slack";
  mode: SlackChannelMode;
  botToken: string;
  appToken: string;
  agentId: string | null;
}

export type ChannelAccount = TelegramChannelAccount | SlackChannelAccount;

// ── Pairing ───────────────────────────────────────────────────────

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

// ── Discovered bind targets ───────────────────────────────────────

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
