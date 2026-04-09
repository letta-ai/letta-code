/**
 * Channel system types.
 *
 * A "channel" connects Letta Code agents to external messaging platforms
 * (Telegram, Slack, etc.). Each channel has an adapter that handles
 * platform-specific communication, and a routing table that maps
 * platform chat IDs to agent+conversation pairs.
 */

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
  sendDirectReply(chatId: string, text: string): Promise<void>;

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
  /** Platform-specific chat/conversation ID. */
  chatId: string;
  /** Platform-specific sender user ID. */
  senderId: string;
  /** Sender display name, if available. */
  senderName?: string;
  /** Message text content. */
  text: string;
  /** Unix timestamp (ms) of the message. */
  timestamp: number;
  /** Platform message ID for threading/replies. */
  messageId?: string;
  /** Raw platform-specific event data for future use. */
  raw?: unknown;
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

export interface TelegramChannelConfig {
  channel: "telegram";
  enabled: boolean;
  token: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
}

export type ChannelConfig = TelegramChannelConfig;

// ── Pairing ───────────────────────────────────────────────────────

export interface PendingPairing {
  code: string;
  telegramUserId: string;
  telegramUsername?: string;
  chatId: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovedUser {
  telegramUserId: string;
  telegramUsername?: string;
  approvedAt: string;
}

export interface PairingStore {
  pending: PendingPairing[];
  approved: ApprovedUser[];
}
