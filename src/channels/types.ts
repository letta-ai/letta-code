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

// ── Adapter interface ─────────────────────────────────────────────

export interface ChannelAdapter {
  /** Platform identifier, e.g. "telegram", "slack". */
  readonly id: string;
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

// ── Attachments ───────────────────────────────────────────────────

export interface InboundImageAttachment {
  /** Base64-encoded image data. */
  data: string;
  /** MIME type, e.g. "image/jpeg". */
  mediaType: string;
}

// ── Message types ─────────────────────────────────────────────────

export interface InboundChannelMessage {
  /** Platform identifier, e.g. "telegram". */
  channel: string;
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
  /** Raw platform-specific event data for future use. */
  raw?: unknown;
  /** Broad chat surface type used for routing/pairing decisions. */
  chatType?: ChannelChatType;
  /** Inbound image attachments (photos, image documents). */
  images?: InboundImageAttachment[];
}

export interface OutboundChannelMessage {
  /** Platform identifier. */
  channel: string;
  /** Target chat/conversation ID. */
  chatId: string;
  /** Message text to send. */
  text: string;
  /** Optional: reply to a specific message. */
  replyToMessageId?: string;
  /** Optional: parse mode hint for the adapter (e.g. "HTML", "MarkdownV2"). */
  parseMode?: string;
}

// ── Routing ───────────────────────────────────────────────────────

export interface ChannelRoute {
  /** Platform-specific chat ID. */
  chatId: string;
  /** Letta agent ID this chat is bound to. */
  agentId: string;
  /** Letta conversation ID this chat is bound to. */
  conversationId: string;
  /** Whether this route is active. */
  enabled: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// ── Config ────────────────────────────────────────────────────────

export type DmPolicy = "pairing" | "allowlist" | "open";
export type SlackChannelMode = "socket";

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

// ── Pairing ───────────────────────────────────────────────────────

export interface PendingPairing {
  code: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovedUser {
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
  targetId: string;
  targetType: "channel";
  chatId: string;
  label: string;
  discoveredAt: string;
  lastSeenAt: string;
  lastMessageId?: string;
}
