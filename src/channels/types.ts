/**
 * Channel system types.
 *
 * A "channel" connects Letta Code agents to external messaging platforms
 * (Telegram, Slack, etc.). Each channel has an adapter that handles
 * platform-specific communication, and a routing table that maps
 * platform chat IDs to agent+conversation pairs.
 */

export const SUPPORTED_CHANNEL_IDS = ["telegram", "slack", "discord"] as const;
export type SupportedChannelId = (typeof SUPPORTED_CHANNEL_IDS)[number];
export type ChannelChatType = "direct" | "channel";
export type SlackDefaultPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

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

export interface ChannelThreadContextEntry {
  messageId?: string;
  senderId?: string;
  senderName?: string;
  text: string;
}

export interface ChannelThreadContext {
  label?: string;
  starter?: ChannelThreadContextEntry;
  history?: ChannelThreadContextEntry[];
}

export interface ChannelTurnSource {
  channel: SupportedChannelId;
  accountId?: string;
  chatId: string;
  chatType?: ChannelChatType;
  messageId?: string;
  threadId?: string | null;
  agentId: string;
  conversationId: string;
}

export type ChannelTurnOutcome = "completed" | "error" | "cancelled";

export type ChannelControlRequestKind =
  | "ask_user_question"
  | "enter_plan_mode"
  | "exit_plan_mode"
  | "generic_tool_approval";

export interface ChannelControlRequestEvent {
  requestId: string;
  kind: ChannelControlRequestKind;
  source: ChannelTurnSource;
  toolName: string;
  input: Record<string, unknown>;
  planFilePath?: string;
  planContent?: string;
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
      error?: string;
    };

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
   * Optionally enrich an inbound message with additional context before it is
   * formatted for the agent. Slack uses this to hydrate older thread context
   * the first time a Letta conversation is created for an existing thread.
   */
  prepareInboundMessage?(
    msg: InboundChannelMessage,
    options?: { isFirstRouteTurn?: boolean },
  ): Promise<InboundChannelMessage>;

  /**
   * Optional lifecycle hook for channel-originated turns. Adapters can use
   * this to surface lightweight UX feedback (for example, Slack reactions)
   * without coupling queue/lifecycle state to a specific channel.
   */
  handleTurnLifecycleEvent?(event: ChannelTurnLifecycleEvent): Promise<void>;

  /**
   * Optional hook for control requests that originate from a channel turn.
   * Adapters can render these natively (or near-natively) for Slack/Telegram
   * instead of relying on a desktop/websocket UI intercept layer.
   */
  handleControlRequestEvent?(event: ChannelControlRequestEvent): Promise<void>;

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
  /** Supplemental thread context captured before the triggering message. */
  threadContext?: ChannelThreadContext;
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

export interface DiscordChannelConfig {
  channel: "discord";
  enabled: boolean;
  token: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
}

export type ChannelConfig =
  | TelegramChannelConfig
  | SlackChannelConfig
  | DiscordChannelConfig;

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
  defaultPermissionMode: SlackDefaultPermissionMode;
}

export interface DiscordChannelAccount extends ChannelAccountBase {
  channel: "discord";
  token: string;
  /** Agent ID used for guild auto-routing (like Slack's agentId). */
  agentId: string | null;
}

export type ChannelAccount =
  | TelegramChannelAccount
  | SlackChannelAccount
  | DiscordChannelAccount;

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
