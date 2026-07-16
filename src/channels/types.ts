/**
 * Channel system types.
 *
 * A "channel" connects Letta Code agents to external messaging platforms
 * (Telegram, Slack, etc.). Each channel has an adapter that handles
 * platform-specific communication, and a routing table that maps
 * platform chat IDs to agent+conversation pairs.
 */

import type { PermissionMode } from "@/permissions/mode";
import type {
  ApprovalResponseBody,
  ListModelsResponseModelEntry,
  StopReasonType,
} from "@/types/protocol_v2";

/**
 * Vendor-neutral model-picker payload produced by the generic channel
 * `/model` handler. Adapters decide how (or whether) to render it.
 */
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

/**
 * Default channel id used for wire compatibility when WS clients omit
 * `channel_id` on channel commands. Early protocol versions predate
 * multi-channel support, when Telegram was the only bundled channel.
 */
export const LEGACY_DEFAULT_CHANNEL_ID = "telegram";

/**
 * Per-turn rich draft streaming policy derived from a channel account's
 * generic opt-in fields. Returns null when the account has not opted in.
 * Any channel account config may declare `richDraftStreaming` /
 * `richPrivateChatDefault`; adapters that also implement
 * `sendRichMessageDraft` get live draft streaming from the listener.
 */
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
/**
 * Built-in channels shipped with Letta Code. Custom channel IDs are discovered
 * at runtime from ~/.letta/channels/<id>/channel.json.
 */
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

/** Per-channel mode for Discord guild channels. */
export type DiscordChannelMode = "open" | "mention-only";

export interface ChannelMessageAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: "image" | "file" | "audio" | "video";
  /** Local file materialized for tool access. Absent when automatic download was skipped. */
  localPath?: string;
  /** Platform message that contains this attachment, used for scoped on-demand downloads. */
  sourceMessageId?: string;
  /** Platform thread that contains this attachment, when it is thread-scoped. */
  sourceThreadId?: string | null;
  /** Why an attachment discovered on the platform was not downloaded automatically. */
  downloadReason?:
    | "exceeds_auto_download_limit"
    | "missing_download_url"
    | "download_failed";
  /** Automatic download threshold that rejected this attachment, when applicable. */
  autoDownloadLimitBytes?: number;
  imageDataBase64?: string;
  /** Best-effort speech-to-text transcription (voice memos only). */
  transcription?: string;
  /** Best-effort reason voice memo transcription failed. */
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
}

export interface ChannelTurnSource {
  channel: string;
  accountId?: string;
  chatId: string;
  chatType?: ChannelChatType;
  /** Platform user who triggered the turn, when known. Slack streaming needs this in channel threads. */
  senderId?: string;
  /** Platform team/workspace for the triggering user, when known. */
  senderTeamId?: string;
  messageId?: string;
  threadId?: string | null;
  agentId: string;
  conversationId: string;
}

export type ChannelTurnOutcome = "completed" | "error" | "cancelled";

export type ChannelTurnProgressKind =
  | "thinking"
  | "responding"
  | "tool"
  | "approval"
  | "command"
  | "status"
  | "retry"
  | "error";

export type ChannelTurnProgressState =
  | "started"
  | "updated"
  | "completed"
  | "error"
  | "waiting";

export interface ChannelTurnProgressUpdate {
  kind: ChannelTurnProgressKind;
  state: ChannelTurnProgressState;
  /** Sanitized, user-facing status text. Never include tool args or output. */
  message: string;
  toolCallId?: string;
  toolName?: string;
  /** Optional sanitized argument summary for expanded tool progress details. */
  toolDetails?: string;
  /**
   * Optional sanitized error-output preview for failed tool calls. Kept
   * separate from toolDetails so surfaces can render it as secondary detail
   * text; it must never be used as a row title/header (LET-9509).
   */
  errorDetails?: string;
  /** Optional sanitized row title for native/rich progress surfaces. */
  toolTitle?: string;
  command?: string;
  runId?: string;
}

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
      error?: string;
      runId?: string;
    };

// ── Adapter interface ─────────────────────────────────────────────

export type ChannelStartupLogger = (message: string) => void;

export interface ChannelAdapterStartOptions {
  logger?: ChannelStartupLogger;
}

export interface ChannelAdapter {
  /** Platform identifier, e.g. "telegram", "slack". */
  readonly id: string;
  /** Channel identifier, e.g. "telegram". */
  readonly channelId?: string;
  /** Account identifier within the channel. */
  readonly accountId?: string;
  /** Human-readable display name, e.g. "Telegram". */
  readonly name: string;

  /** Start receiving messages (e.g. begin long-polling). */
  start(options?: ChannelAdapterStartOptions): Promise<void>;
  /** Stop receiving messages gracefully. */
  stop(): Promise<void>;
  /** Whether the adapter is currently running. */
  isRunning(): boolean;

  /** Send a message through this channel. */
  sendMessage(msg: OutboundChannelMessage): Promise<{ messageId: string }>;

  /**
   * Optionally materialize a platform attachment into the channel's local
   * inbound directory. MessageChannel plugins expose this only when the
   * adapter can verify the attachment against its canonical source message.
   */
  downloadAttachment?(params: {
    attachmentId: string;
    chatId: string;
    threadId?: string | null;
    messageId: string;
    signal?: AbortSignal;
  }): Promise<ChannelMessageAttachment>;

  /**
   * Optionally stream an ephemeral rich-message draft while a final rich
   * message is being generated. Drafts are best-effort previews; callers must
   * still send a final persistent message with sendMessage().
   */
  sendRichMessageDraft?(draft: OutboundChannelRichMessageDraft): Promise<void>;

  /**
   * Send a direct reply on the platform (for pairing codes, no-route
   * messages, etc.) without going through the agent.
   */
  sendDirectReply(
    chatId: string,
    text: string,
    options?: {
      replyToMessageId?: string;
      threadId?: string | null;
      /**
       * Structured model-picker data. Adapters with native rich UI (for
       * example Slack Block Kit) may render it; others fall back to text.
       */
      modelPicker?: ChannelModelPickerData;
    },
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
   * Optional progress hook for channel-originated turns. Payloads are generic
   * and sanitized before they reach adapters; adapters decide how to render and
   * throttle their platform-specific UX.
   */
  handleTurnProgressEvent?(event: ChannelTurnProgressEvent): Promise<void>;

  /**
   * Optional hook for control requests that originate from a channel turn.
   * Adapters can render these natively (or near-natively) for Slack/Telegram
   * instead of relying on a desktop/websocket UI intercept layer.
   */
  handleControlRequestEvent?(event: ChannelControlRequestEvent): Promise<void>;

  /** Wired by ChannelRegistry for native approval controls such as Slack buttons. */
  onControlResponse?: (
    input: ChannelControlResponseInput,
  ) => Promise<ChannelControlResponseResult>;

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
  /** Platform-specific sender team/workspace ID, when available. */
  senderTeamId?: string;
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
  /** Whether this message is policy-permitted ambient traffic in an open channel. */
  isOpenChannel?: boolean;
  /** For platform channel threads, the parent channel ID (e.g. Discord guild channel). */
  parentChannelId?: string;
  /** Downloaded attachments/media associated with the inbound message. */
  attachments?: ChannelMessageAttachment[];
  /** Reaction metadata for non-text channel events. */
  reaction?: ChannelReactionNotification;
  /** Platform quote/reply context for messages sent in reply to another message. */
  replyContext?: ChannelReplyContext;
  /** Supplemental thread context captured before the triggering message. */
  threadContext?: ChannelThreadContext;
}

export interface ChannelRichMessage {
  /** Rich-message HTML content. Exactly one of html or markdown should be provided. */
  html?: string;
  /** Rich-message Markdown content. Exactly one of html or markdown should be provided. */
  markdown?: string;
  /** Optional: render the rich message right-to-left. */
  isRtl?: boolean;
  /** Optional: disable Telegram's automatic entity detection. */
  skipEntityDetection?: boolean;
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
  /** Optional: rich structured message payload for channels that support it. */
  richMessage?: ChannelRichMessage;
  /** Optional: Signal-style text ranges (start:length:STYLE) for platforms that support rich text entities. */
  textStyle?: string[];
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
  /** Optional: sending agent identity, used by adapters that render web deep links. */
  agentId?: string;
  /** Optional: conversation identity, used by adapters that render web deep links. */
  conversationId?: string;
}

export interface OutboundChannelRichMessageDraft {
  /** Platform identifier. */
  channel: string;
  /** Channel account that should send the draft. */
  accountId?: string;
  /** Target chat/conversation ID. */
  chatId: string;
  /** Optional: canonical thread identifier used for threaded channels. */
  threadId?: string | null;
  /** Stable non-zero platform draft identifier for animated updates. */
  draftId: number;
  /** Rich structured message payload for the draft preview. */
  richMessage: ChannelRichMessage;
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
  /** Whether this route permits outbound MessageChannel sends. Defaults true. */
  outboundEnabled?: boolean;
  /** Slack-only: a detached thread stays silent until the app is mentioned again. */
  detached?: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 update timestamp. */
  updatedAt?: string;
}

// ── Config ────────────────────────────────────────────────────────

export type DmPolicy = "pairing" | "allowlist" | "open";
export type SlackChannelMode = "socket";
export type SlackAllowBotsMode = false | "mentions";
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
  createdAt: string;
  updatedAt: string;
}

export interface CustomChannelAccount extends ChannelAccountBase {
  channel: string;
  /** Plugin-owned persisted account settings. May contain secrets. */
  config: Record<string, unknown>;
}

export interface TelegramChannelConfig {
  channel: "telegram";
  enabled: boolean;
  token: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  /** Group/supergroup behavior: ambient open chat or explicit mentions only. */
  groupMode?: TelegramGroupMode;
  /** When true and OPENAI_API_KEY is set, voice memos are auto-transcribed. */
  transcribeVoice?: boolean;
  /**
   * Default true. When true, normal Telegram private-chat `send` actions use
   * Bot API Rich Messages; explicit `send-rich` remains available either way.
   */
  richPrivateChatDefault?: boolean;
  /** When true, stream hidden Telegram rich-message drafts during generation. */
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
  /** When true and OPENAI_API_KEY is set, inbound audio attachments are auto-transcribed. */
  transcribeVoice?: boolean;
  /** When true, unmentioned Slack thread replies are delivered read-only until an @mention. */
  listenMode?: boolean;
  /**
   * Bot-authored inbound policy. Default false drops bot messages. "mentions"
   * accepts only explicit foreign bot mentions. There is intentionally no
   * accept-all mode until Letta has a shared pair-loop guard.
   */
  allowBots?: SlackAllowBotsMode;
}

export interface DiscordChannelConfig {
  channel: "discord";
  enabled: boolean;
  token: string;
  defaultPermissionMode: DiscordDefaultPermissionMode;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  /**
   * Optional allowlist or mode map for guild channels.
   *
   * Legacy `string[]` — each entry is treated as "mention-only".
   * `Record<channelId, mode>` — each channel declares its behavior:
   *   - `"open"`: respond to every non-bot message, no @mention required
   *   - `"mention-only"`: only respond when the bot is @mentioned
   *
   * Empty/undefined preserves the default behavior of processing
   * all guild channels the bot can see (mention-only for non-thread
   * messages, open for threads with an existing route).
   */
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  /**
   * When `true`, @mentions in non-thread guild channels auto-create a
   * Discord thread for the conversation. When `false`, the bot replies
   * directly in the parent channel. Default `false`; thread creation is opt-in.
   */
  autoThreadOnMention?: boolean;
  /**
   * Per-channel override map for thread creation on @mention.
   * Key: guild channel ID. Value: `true` to auto-create a thread on
   * @mention in that channel, `false` to reply in-line.
   * Resolution order: per-channel override → account-level
   * `autoThreadOnMention` → `false`.
   */
  threadPolicyByChannel?: Record<string, boolean>;
  /**
   * When true, the bot sends lifecycle reaction acknowledgments on messages
   * (👀 on receipt, ✅ on completion). Default false — the typing indicator
   * is the primary UX for in-flight feedback.
   */
  acknowledgeMessageReaction?: boolean;
  /**
   * When true and a guild channel is removed from `allowedChannels`,
   * stale routes for that channel can be removed by reconcile `--apply`.
   * This only removes routes (not conversations). Default false — routes
   * are preserved even if the channel is no longer allowed.
   */
  removeStaleRoutes?: boolean;
  /**
   * Optional debounce window (ms) for inbound open-channel guild messages.
   * When greater than `0`, short back-to-back messages from the same sender
   * in the same channel/thread stack into a single combined dispatch
   * (trailing edge). Default `0` (disabled). Only applies to
   * open-channel messages; DMs, @mentions, attachments, and reactions always
   * bypass.
   * The env var `LETTA_DISCORD_INBOUND_DEBOUNCE_MS` takes precedence if set.
   * Clamped to `0..10000`.
   */
  inboundDebounceMs?: number;
}

export interface WhatsAppChannelConfig {
  channel: "whatsapp";
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  agentId: string | null;
  /** Default true. When true, only the user's own Message Yourself chat routes. */
  selfChatMode: boolean;
  /** Default disabled. Controls group-message ingestion. */
  groupMode: WhatsAppGroupMode;
  /** Optional allowlist of WhatsApp group JIDs. Empty/undefined allows any group when groupMode is not disabled. */
  allowedGroups?: string[];
  /** Optional textual aliases for group mention detection. */
  mentionPatterns?: string[];
  /** When true and OPENAI_API_KEY is set, voice memos are auto-transcribed. */
  transcribeVoice?: boolean;
  /** When true, supported inbound media is downloaded to local channel storage. */
  downloadMedia?: boolean;
  /** Maximum inbound media bytes to download. Undefined uses channel default. */
  mediaMaxBytes?: number;
}

export interface SignalChannelConfig {
  channel: "signal";
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  /** Base URL for a Signal JSON-RPC/SSE bridge, e.g. http://127.0.0.1:8080. */
  baseUrl: string;
  /** Optional signal-cli account selector, usually the linked phone number. */
  account?: string;
  /** Optional UUID for self-message filtering when Signal sends UUID identities. */
  accountUuid?: string;
  /** Agent ID used for account-bound DM and group auto-routing. */
  agentId: string | null;
  /** Default false. When true, only the linked account's own Note to Self/self-chat messages route. */
  selfChatMode: boolean;
  /** Default disabled. Controls group-message ingestion. */
  groupMode: SignalGroupMode;
  /** Optional allowlist of Signal group ids. */
  allowedGroups?: string[];
  /** Optional textual aliases for group mention detection. */
  mentionPatterns?: string[];
  /** Optional sender identity -> replyable Signal recipient mapping, e.g. UUID to E.164 phone. */
  recipientAliases?: Record<string, string>;
  /** When true and OPENAI_API_KEY is set, inbound audio attachments are auto-transcribed. */
  transcribeVoice?: boolean;
  /** Default true. When true, supported inbound media is downloaded and surfaced to the agent. */
  downloadMedia?: boolean;
  /** Maximum inbound media bytes to consider. Undefined uses channel default. */
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
  /**
   * Group/supergroup behavior. `open` preserves existing ambient room routing;
   * `mention-only` only delivers messages explicitly addressed to this bot.
   */
  groupMode?: TelegramGroupMode;
  /** When true and OPENAI_API_KEY is set, voice memos are auto-transcribed. */
  transcribeVoice?: boolean;
  /**
   * Default true. When true, normal Telegram private-chat MessageChannel sends
   * are delivered through Bot API Rich Messages. Set false to keep `send`
   * plain/HTML-formatted unless the agent explicitly uses `send-rich`.
   */
  richPrivateChatDefault?: boolean;
  /**
   * When true, Telegram channel turns may stream hidden rich-message drafts
   * while the agent is preparing a final MessageChannel send-rich call.
   */
  richDraftStreaming?: boolean;
  /**
   * Optional debounce window (ms) for inbound group/topic messages. When
   * greater than `0`, short back-to-back text messages in the same chat/topic
   * stack into a single combined dispatch (trailing edge). Default `0`
   * (disabled). DMs, attachments, and reactions bypass. The env var
   * `LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS` takes precedence if set. Clamped to
   * `0..10000`.
   */
  inboundDebounceMs?: number;
}

export interface SlackChannelAccount extends ChannelAccountBase {
  channel: "slack";
  mode: SlackChannelMode;
  botToken: string;
  appToken: string;
  agentId: string | null;
  defaultPermissionMode: SlackDefaultPermissionMode;
  /** When true and OPENAI_API_KEY is set, inbound audio attachments are auto-transcribed. */
  transcribeVoice?: boolean;
  /** When true, unmentioned Slack thread replies are delivered read-only until an @mention. */
  listenMode?: boolean;
  /**
   * Bot-authored inbound policy. Default false drops bot messages. "mentions"
   * accepts only explicit foreign bot mentions. There is intentionally no
   * accept-all mode until Letta has a shared pair-loop guard.
   */
  allowBots?: SlackAllowBotsMode;
  /**
   * Optional debounce window (ms) for inbound messages. When greater than
   * `0`, short back-to-back messages from the same sender in the same
   * chat/thread stack into a single combined dispatch (trailing edge).
   * Default `0` (disabled). Messages with attachments bypass the debounce.
   * The env var `LETTA_SLACK_INBOUND_DEBOUNCE_MS` takes precedence if set.
   */
  inboundDebounceMs?: number;
}

export interface DiscordChannelAccount extends ChannelAccountBase {
  channel: "discord";
  token: string;
  /** When true and OPENAI_API_KEY is set, inbound audio attachments are auto-transcribed. */
  transcribeVoice?: boolean;
  /** Agent ID used for account-bound DM and guild auto-routing. */
  agentId: string | null;
  /** Permission mode for new Discord-created conversations. */
  defaultPermissionMode: DiscordDefaultPermissionMode;
  /**
   * Optional allowlist or mode map for guild channels.
   *
   * Legacy `string[]` — each entry is treated as "mention-only".
   * `Record<channelId, mode>` — each channel declares its behavior:
   *   - `"open"`: respond to every non-bot message, no @mention required
   *   - `"mention-only"`: only respond when the bot is @mentioned
   *
   * Empty/undefined preserves the default behavior of processing
   * all guild channels the bot can see. DMs are unaffected.
   */
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
  /**
   * When `true`, @mentions in non-thread guild channels auto-create a
   * Discord thread for the conversation. When `false`, the bot replies
   * directly in the parent channel. Default `false`; thread creation is opt-in.
   */
  autoThreadOnMention?: boolean;
  /**
   * Per-channel override map for thread creation on @mention.
   * Key: guild channel ID. Value: `true` to auto-create a thread on
   * @mention in that channel, `false` to reply in-line.
   * Resolution order: per-channel override → account-level
   * `autoThreadOnMention` → `false`.
   */
  threadPolicyByChannel?: Record<string, boolean>;
  /**
   * When true, the bot sends lifecycle reaction acknowledgments on messages
   * (👀 on receipt, ✅ on completion). Default false — the typing indicator
   * is the primary UX for in-flight feedback.
   */
  acknowledgeMessageReaction?: boolean;
  /**
   * When true and a guild channel is removed from `allowedChannels`,
   * stale routes for that channel can be removed by reconcile `--apply`.
   * This only removes routes (not conversations). Default false — routes
   * are preserved even if the channel is no longer allowed.
   */
  removeStaleRoutes?: boolean;
  /**
   * Optional debounce window (ms) for inbound open-channel guild messages.
   * When greater than `0`, short back-to-back messages from the same sender
   * in the same channel/thread stack into a single combined dispatch
   * (trailing edge). Default `0` (disabled). Only applies to
   * open-channel messages; DMs, @mentions, attachments, and reactions always
   * bypass.
   * The env var `LETTA_DISCORD_INBOUND_DEBOUNCE_MS` takes precedence if set.
   * Clamped to `0..10000`.
   */
  inboundDebounceMs?: number;
}

export interface WhatsAppChannelAccount extends ChannelAccountBase {
  channel: "whatsapp";
  /** Agent ID used for account-bound DM and group auto-routing. */
  agentId: string | null;
  /** Default true. Explicitly set false before replying under the linked user's identity. */
  selfChatMode: boolean;
  /** Default disabled. Controls group-message ingestion. */
  groupMode: WhatsAppGroupMode;
  /** Optional allowlist of WhatsApp group JIDs. */
  allowedGroups?: string[];
  /** Optional textual aliases for group mention detection. */
  mentionPatterns?: string[];
  /** When true and OPENAI_API_KEY is set, voice memos are auto-transcribed. */
  transcribeVoice?: boolean;
  /** When true, supported inbound media is downloaded to local channel storage. */
  downloadMedia?: boolean;
  /** Maximum inbound media bytes to download. Undefined uses channel default. */
  mediaMaxBytes?: number;
}

export interface SignalChannelAccount extends ChannelAccountBase {
  channel: "signal";
  /** Base URL for a Signal JSON-RPC/SSE bridge, e.g. http://127.0.0.1:8080. */
  baseUrl: string;
  /** Optional signal-cli account selector, usually the linked phone number. */
  account?: string;
  /** Optional UUID for self-message filtering when Signal sends UUID identities. */
  accountUuid?: string;
  /** Agent ID used for account-bound DM and group auto-routing. */
  agentId: string | null;
  /** Default false. When true, only the linked account's own Note to Self/self-chat messages route. */
  selfChatMode: boolean;
  /** Default disabled. Controls group-message ingestion. */
  groupMode: SignalGroupMode;
  /** Optional allowlist of Signal group ids. */
  allowedGroups?: string[];
  /** Optional textual aliases for group mention detection. */
  mentionPatterns?: string[];
  /** Optional sender identity -> replyable Signal recipient mapping, e.g. UUID to E.164 phone. */
  recipientAliases?: Record<string, string>;
  /** When true and OPENAI_API_KEY is set, inbound audio attachments are auto-transcribed. */
  transcribeVoice?: boolean;
  /** Default true. When true, supported inbound media is downloaded and surfaced to the agent. */
  downloadMedia?: boolean;
  /** Maximum inbound media bytes to consider. Undefined uses channel default. */
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
  // The "custom" first-party channel and all user-installed channels share the
  // same generic config-bag shape (no specific fields like `token`).
  if (account.channel === "custom") {
    return "config" in account;
  }
  return !isFirstPartyChannelId(account.channel) && "config" in account;
}

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
