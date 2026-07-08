import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type SlackApp from "@slack/bolt";
import { isLocalAgentId } from "@/agent/agent-id";
import { listChannelSlashCommands } from "@/channels/commands";
import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "@/channels/inbound-debounce";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import {
  formatChannelLifecycleErrorMessage,
  getChannelLifecycleErrorDisplay,
} from "@/channels/lifecycle-error";
import {
  isSkillToolName,
  sanitizeChannelProgressCore,
  truncateChannelProgressText,
} from "@/channels/progress";
import {
  buildSlackModelPickerBlocks,
  SLACK_MODEL_SELECT_ACTION_ID,
} from "@/channels/slack/model-picker-blocks";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelModelPickerData,
  ChannelTurnLifecycleEvent,
  ChannelTurnOutcome,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  SlackChannelAccount,
  SlackProgressUiMode,
} from "@/channels/types";
import {
  getDisplayToolName,
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isGlobTool,
  isSearchTool,
  isShellTool,
  isTaskTool,
  isWebSearchTool,
} from "@/cli/helpers/tool-name-mapping";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  resolveSlackChannelHistory,
  resolveSlackInboundAttachments,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
} from "./media";
import { loadSlackBoltModule } from "./runtime";
import { createSlackWebApiClient } from "./web-api-client";

type SlackAppConstructor = typeof import("@slack/bolt").App;
type SlackBoltModule = typeof import("@slack/bolt") & {
  default?: unknown;
};
type SlackWriteClient = {
  chat: {
    postMessage: (args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: SlackBlock[];
    }) => Promise<{ ts?: string }>;
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: SlackBlock[];
    }) => Promise<{ ts?: string }>;
    delete?: (args: {
      channel: string;
      ts: string;
    }) => Promise<{ ok?: boolean; error?: string }>;
    startStream?: (args: SlackStartStreamArgs) => Promise<SlackStreamResponse>;
    appendStream?: (
      args: SlackAppendStreamArgs,
    ) => Promise<SlackStreamResponse>;
    stopStream?: (args: SlackStopStreamArgs) => Promise<SlackStreamResponse>;
  };
  assistant?: {
    threads?: {
      setStatus?: (args: {
        channel_id: string;
        thread_ts: string;
        status: string;
        loading_messages?: string[];
      }) => Promise<unknown>;
    };
  };
  reactions: {
    add: (args: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
    remove: (args: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
  };
  files: {
    getUploadURLExternal: (args: {
      filename: string;
      length: number;
    }) => Promise<{
      ok?: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    }>;
    completeUploadExternal: (args: {
      files: Array<{ id: string; title: string }>;
      channel_id: string;
      initial_comment?: string;
      thread_ts?: string;
    }) => Promise<{ ok?: boolean; error?: string }>;
  };
};
type SlackReactionEvent = {
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  user?: string;
  item_user?: string;
  reaction?: string;
  event_ts?: string;
  team?: string;
  team_id?: string;
  user_team?: string;
};

type SlackCommandPayload = {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  channel_name?: string;
  team_id?: string;
  trigger_id?: string;
};

type SlackTextObject = {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
};

type SlackOption = {
  text: SlackTextObject;
  value: string;
  description?: SlackTextObject;
};

type SlackButtonElement = {
  type: "button";
  text: SlackTextObject;
  url: string;
  action_id: string;
};

type SlackStaticSelectElement = {
  type: "static_select";
  action_id: string;
  placeholder?: SlackTextObject;
  options: SlackOption[];
  initial_option?: SlackOption;
};

type SlackBlockElement = SlackButtonElement | SlackStaticSelectElement;

type SlackBlock =
  | {
      type: "section";
      text: SlackTextObject;
      accessory?: SlackBlockElement;
    }
  | {
      type: "context";
      elements: SlackTextObject[];
    }
  | {
      type: "divider";
    }
  | {
      type: "actions";
      elements: SlackBlockElement[];
    };

type SlackStreamTaskStatus = "pending" | "in_progress" | "complete" | "error";

type SlackStreamChunk =
  | {
      type: "markdown_text";
      text: string;
    }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: SlackStreamTaskStatus;
      details?: string;
      output?: string;
    }
  | {
      type: "plan_update";
      title: string;
    }
  | {
      type: "blocks";
      blocks: SlackBlock[];
    };

type SlackStartStreamArgs = {
  channel: string;
  thread_ts: string;
  markdown_text?: string;
  chunks?: SlackStreamChunk[];
  task_display_mode?: "timeline" | "plan" | "dense";
  recipient_user_id?: string;
  recipient_team_id?: string;
};

type SlackAppendStreamArgs = {
  channel: string;
  ts: string;
  markdown_text?: string;
  chunks?: SlackStreamChunk[];
};

type SlackStopStreamArgs = {
  channel: string;
  ts: string;
  markdown_text?: string;
  chunks?: SlackStreamChunk[];
  blocks?: SlackBlock[];
};

type SlackStreamResponse = {
  ok?: boolean;
  channel?: string;
  ts?: string;
  error?: string;
};

type Constructor = abstract new (...args: never[]) => unknown;

function isConstructorFunction<T extends Constructor>(
  value: unknown,
): value is T {
  return typeof value === "function";
}

function resolveSlackAppModule(value: unknown): SlackAppConstructor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const app = Reflect.get(value, "App");
  return isConstructorFunction<SlackAppConstructor>(app) ? app : null;
}
const INITIAL_SLACK_THREAD_HISTORY_LIMIT = 20;

const SLACK_ASSISTANT_STATUS_VERBS = Object.freeze([
  "cogitating",
  "thinking",
  "processing",
] as const);

function getRandomSlackAssistantStatusVerb(): string {
  const index = Math.floor(Math.random() * SLACK_ASSISTANT_STATUS_VERBS.length);
  return `is ${SLACK_ASSISTANT_STATUS_VERBS[index] ?? "thinking"}...`;
}

function resolveSlackAppConstructor(mod: SlackBoltModule): SlackAppConstructor {
  const defaultExport =
    mod && typeof mod === "object" ? Reflect.get(mod, "default") : undefined;
  const nestedDefault =
    defaultExport && typeof defaultExport === "object"
      ? Reflect.get(defaultExport, "default")
      : undefined;

  const App =
    resolveSlackAppModule(mod) ??
    resolveSlackAppModule(defaultExport) ??
    resolveSlackAppModule(nestedDefault) ??
    (isConstructorFunction<SlackAppConstructor>(defaultExport)
      ? defaultExport
      : null);

  if (!App) {
    throw new Error(
      'Installed Slack runtime did not export constructor "App".',
    );
  }
  return App;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(isNonEmptyString);
}

function getSlackErrorCode(error: unknown): string | undefined {
  if (isNonEmptyString(error)) {
    return error;
  }
  const record = asRecord(error);
  return firstNonEmptyString(record?.error, record?.code);
}

function isSlackMessageNotStreamingStateError(error: unknown): boolean {
  const code = getSlackErrorCode(error);
  if (code === "message_not_in_streaming_state") {
    return true;
  }
  return error instanceof Error
    ? error.message.includes("message_not_in_streaming_state")
    : false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function resolveSlackSenderTeamId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return firstNonEmptyString(record.user_team, record.team_id, record.team);
}

function normalizeSlackText(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>\s*)+/, "").trim();
}

const IGNORED_SLACK_MESSAGE_SUBTYPES = new Set([
  "assistant_app_thread",
  "bot_message",
  "channel_archive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_posting_permissions",
  "channel_purpose",
  "channel_topic",
  "channel_unarchive",
  "document_mention",
  "ekm_access_denied",
  "file_comment",
  "group_archive",
  "group_join",
  "group_leave",
  "group_name",
  "group_purpose",
  "group_topic",
  "group_unarchive",
  "pinned_item",
  "reminder_add",
  "unpinned_item",
]);

const WRAPPER_SLACK_MESSAGE_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "message_replied",
]);

type SlackProcessableInboundMessage = Record<string, unknown> & {
  user: string;
  ts: string;
};

function isProcessableSlackInboundMessage(
  rawMessage: Record<string, unknown>,
): rawMessage is SlackProcessableInboundMessage {
  if (isNonEmptyString(rawMessage.bot_id)) {
    return false;
  }

  if (!isNonEmptyString(rawMessage.user) || !isNonEmptyString(rawMessage.ts)) {
    return false;
  }

  // Slack uses subtypes for both real user-authored messages (for example
  // thread broadcasts and file shares) and bookkeeping/admin wrappers. Don't
  // blanket-drop all subtype messages; instead ignore the known non-user
  // variants and let genuine user messages keep flowing into the routed thread.
  if (rawMessage.hidden === true) {
    return false;
  }

  const subtype = isNonEmptyString(rawMessage.subtype)
    ? rawMessage.subtype
    : null;
  if (!subtype) {
    return true;
  }

  if (IGNORED_SLACK_MESSAGE_SUBTYPES.has(subtype)) {
    return false;
  }

  return !(
    WRAPPER_SLACK_MESSAGE_SUBTYPES.has(subtype) &&
    asRecord(rawMessage.message) !== null
  );
}

function slackTimestampToMillis(timestamp: string): number {
  return Math.round(Number.parseFloat(timestamp) * 1000);
}

function resolveSlackChatType(chatId: string): "direct" | "channel" {
  return chatId.startsWith("D") ? "direct" : "channel";
}

function resolveSlackOutboundThreadTs(params: {
  chatId: string;
  threadId?: string | null;
  replyToMessageId?: string | null;
}): string | undefined {
  if (resolveSlackChatType(params.chatId) === "direct") {
    return firstNonEmptyString(params.threadId);
  }
  return firstNonEmptyString(params.threadId, params.replyToMessageId);
}

function asSlackBlocks(
  blocks: unknown[] | undefined,
): SlackBlock[] | undefined {
  return Array.isArray(blocks) ? (blocks as SlackBlock[]) : undefined;
}

function getSlackActionRecord(
  action: unknown,
  body: unknown,
): Record<string, unknown> | null {
  const directAction = asRecord(action);
  if (directAction) {
    return directAction;
  }
  const actions = asRecord(body)?.actions;
  if (!Array.isArray(actions)) {
    return null;
  }
  return asRecord(actions[0]);
}

function resolveSlackSelectedModel(
  action: unknown,
  body: unknown,
): string | null {
  const actionRecord = getSlackActionRecord(action, body);
  const selectedOption = asRecord(actionRecord?.selected_option);
  return (
    firstNonEmptyString(selectedOption?.value, actionRecord?.value) ?? null
  );
}

function resolveSlackActionChannelId(body: unknown): string | null {
  const bodyRecord = asRecord(body);
  const channel = asRecord(bodyRecord?.channel);
  const container = asRecord(bodyRecord?.container);
  return firstNonEmptyString(channel?.id, container?.channel_id) ?? null;
}

function resolveSlackActionThreadId(body: unknown): string | null {
  const bodyRecord = asRecord(body);
  const container = asRecord(bodyRecord?.container);
  const message = asRecord(bodyRecord?.message);
  return firstNonEmptyString(container?.thread_ts, message?.thread_ts) ?? null;
}

function resolveSlackActionMessageId(body: unknown): string | undefined {
  const bodyRecord = asRecord(body);
  const container = asRecord(bodyRecord?.container);
  const message = asRecord(bodyRecord?.message);
  return firstNonEmptyString(container?.message_ts, message?.ts);
}

function resolveSlackActionUser(body: unknown): {
  id: string | null;
  name?: string;
  teamId?: string;
} {
  const user = asRecord(asRecord(body)?.user);
  return {
    id: firstNonEmptyString(user?.id) ?? null,
    name: firstNonEmptyString(user?.name, user?.username, user?.id),
    teamId: firstNonEmptyString(user?.team_id),
  };
}

function resolveSlackSourceThreadTs(
  source: ChannelTurnSource,
): string | undefined {
  if (
    source.chatType === "direct" ||
    resolveSlackChatType(source.chatId) === "direct"
  ) {
    return firstNonEmptyString(source.threadId);
  }
  return firstNonEmptyString(source.threadId, source.messageId);
}

function resolveSlackProgressThreadTs(
  source: ChannelTurnSource,
): string | undefined {
  if (
    source.chatType === "direct" ||
    resolveSlackChatType(source.chatId) === "direct"
  ) {
    // Top-level DM replies stay unthreaded, but Slack's assistant status and
    // native progress stream still need a temporary thread anchor. Use the
    // inbound DM message ts only for progress/status plumbing.
    return firstNonEmptyString(source.threadId, source.messageId);
  }
  return resolveSlackSourceThreadTs(source);
}

function resolveSlackOutboundProgressThreadTs(params: {
  threadId?: string | null;
  replyToMessageId?: string | null;
}): string | undefined {
  return firstNonEmptyString(params.threadId, params.replyToMessageId);
}

function normalizeSlackReactionName(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "");
}

const SLACK_INGRESS_DEDUPE_TTL_MS = 60_000;
const SLACK_INGRESS_DEDUPE_MAX = 2_000;
const SLACK_LIFECYCLE_ERROR_TEXT_MAX = 3_000;
const SLACK_PROGRESS_CARD_TEXT_MAX = 300;
const SLACK_PROGRESS_CARD_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const SLACK_PROGRESS_CARD_STATE_MAX = 2_000;
const SLACK_ORPHANED_STREAMS_PER_THREAD_MAX = 4;
const SLACK_ORPHANED_STREAM_THREADS_MAX = 500;
const SLACK_STREAM_CHUNK_TEXT_MAX = 256;
const SLACK_LIFECYCLE_ERROR_TASK_ID = "task_lifecycle_error";
const SLACK_CHANNEL_RESPONSE_TASK_ID = "task_channel_response";
const SLACK_TURN_ACTIVE_TASK_ID = "task_turn_active";
const DEFAULT_SLACK_PROGRESS_UPDATE_THROTTLE_MS = 1_000;
const DEFAULT_SLACK_PROGRESS_STREAM_KEEPALIVE_MS = 60_000;
const DEFAULT_SLACK_COMPLETION_FINALIZE_GRACE_MS = 500;
// Threads the agent has sent messages to should auto-subscribe: when a user
// replies in such a thread without mentioning the agent, the reply is still
// implicitly addressed to the agent. This TTL controls how long we remember
// agent-participated threads after the last outbound message.
const SLACK_AGENT_THREAD_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_AGENT_THREAD_MAX = 2_000;

type SlackProgressCardState =
  | "processing"
  | "completed"
  | "error"
  | "cancelled";

type SlackProgressToolTask = {
  id: string;
  kind: ChannelTurnProgressEvent["kind"];
  /** Raw tool name, when known. Titles are re-derived from this per status. */
  toolName?: string;
  /** Preformatted channel-facing row title from the progress builder. */
  toolTitle?: string;
  title: string;
  status: SlackStreamTaskStatus;
  details?: string;
  wasError?: boolean;
};

type SlackProgressCardEntry = {
  source: ChannelTurnSource;
  /**
   * Progress transport for this turn:
   * - "stream": native streaming card with task rows (card view)
   * - "status-stream": native stream carrying only plan_update titles — a
   *   shimmering dim status line that the reply replaces at stop (simple view)
   * - "text": plain message edited in place (fallback when the client/
   *   workspace does not support chat.startStream)
   */
  mode?: "stream" | "status-stream" | "text";
  streamTs?: string;
  /** Last plan title delivered to a status stream (dedupes appends). */
  lastPlanTitle?: string;
  /** Message ts of the plain text-mode progress message, edited in place. */
  textTs?: string;
  /**
   * Set once Slack reports the stream left streaming state while we still
   * expected it to be live (expiry, external stop). A dead stream never
   * accepts appends again; the terminal flush rewrites the message via
   * chat.update instead so the card cannot stay stuck on a red spinner row.
   */
  streamDead?: boolean;
  status: SlackProgressCardState;
  latestText: string;
  latestUpdate?: ChannelTurnProgressEvent;
  toolNamesByCallId?: Map<string, string>;
  toolDetailsByCallId?: Map<string, string>;
  toolTitlesByCallId?: Map<string, string>;
  toolTasksById?: Map<string, SlackProgressToolTask>;
  sentTaskDetailsById?: Map<string, string>;
  completionHeaderText?: string;
  /** Sanitized turn error text, set for error outcomes at finish time. */
  errorText?: string;
  reasoningActive?: boolean;
  placeholderTaskId?: string;
  placeholderTaskSequence?: number;
  toolTaskIdsByCallId?: Map<string, string>;
  pendingStreamChunks?: SlackStreamChunk[];
  hiddenToolCallIds?: Set<string>;
  completedFinalizerTimer?: ReturnType<typeof setTimeout>;
  lastSentText?: string;
  lastSentAt: number;
  pendingTimer?: ReturnType<typeof setTimeout>;
  keepaliveTimer?: ReturnType<typeof setTimeout>;
  /** Proactive status-stream roll timer (Slack hard-caps stream lifetime). */
  streamRollTimer?: ReturnType<typeof setTimeout>;
  pendingFlush?: Promise<void>;
  requeuedFailedChunks?: boolean;
  updatedAt: number;
};

export function resolveSlackProgressUpdateThrottleMs(): number {
  const raw = process.env.LETTA_SLACK_PROGRESS_UPDATE_THROTTLE_MS;
  if (!raw) {
    return DEFAULT_SLACK_PROGRESS_UPDATE_THROTTLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SLACK_PROGRESS_UPDATE_THROTTLE_MS;
  }
  return Math.min(parsed, 30_000);
}

// Slack hard-caps stream lifetime at ~5 minutes regardless of append
// activity (live-measured 2026-07-08: death at 303s with 30s appends). Roll
// status streams comfortably before the cap so the placeholder never freezes.
const DEFAULT_SLACK_STATUS_STREAM_ROLL_MS = 240_000;

export function resolveSlackStatusStreamRollMs(): number {
  const raw = process.env.LETTA_SLACK_STATUS_STREAM_ROLL_MS;
  if (!raw) {
    return DEFAULT_SLACK_STATUS_STREAM_ROLL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SLACK_STATUS_STREAM_ROLL_MS;
  }
  return Math.min(parsed, 290_000);
}

export function resolveSlackProgressStreamKeepaliveMs(): number {
  const raw = process.env.LETTA_SLACK_PROGRESS_STREAM_KEEPALIVE_MS;
  if (!raw) {
    return DEFAULT_SLACK_PROGRESS_STREAM_KEEPALIVE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SLACK_PROGRESS_STREAM_KEEPALIVE_MS;
  }
  return Math.min(Math.trunc(parsed), 300_000);
}

export function resolveSlackCompletionFinalizeGraceMs(): number {
  const raw = process.env.LETTA_SLACK_COMPLETION_FINALIZE_GRACE_MS;
  if (!raw) {
    return DEFAULT_SLACK_COMPLETION_FINALIZE_GRACE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SLACK_COMPLETION_FINALIZE_GRACE_MS;
  }
  return Math.min(Math.trunc(parsed), 30_000);
}

/**
 * Build a chat.letta.com deep link for an agent/conversation.
 * Local-backend agents do not exist on the web app, so return undefined.
 */
function buildSlackChatUrl(
  agentId: string,
  conversationId: string,
): string | undefined {
  if (isLocalAgentId(agentId)) {
    return undefined;
  }
  const base = `https://chat.letta.com/chat/${agentId}`;
  if (conversationId && conversationId !== "default") {
    return `${base}?conversation=${conversationId}`;
  }
  return base;
}

/**
 * Build small footnote text with a web deep link for the conversation.
 * Returns an empty string for local-backend agents.
 */
function buildSlackChatFootnote(identity: {
  agentId: string;
  conversationId: string;
}): string {
  const chatUrl = buildSlackChatUrl(identity.agentId, identity.conversationId);
  if (!chatUrl) {
    return "";
  }
  // Slack mrkdwn link format: <URL|text>
  return `<${chatUrl}|View on web>`;
}

// Slack section blocks cap mrkdwn text at 3000 characters.
const SLACK_SECTION_TEXT_MAX = 3_000;

/**
 * Render an outbound reply as mrkdwn section blocks with a small context
 * footnote (web deep link) below the text. Returns undefined
 * when the text cannot be represented within Slack's 50-block limit, in
 * which case the caller falls back to plain text without the footnote.
 */
function buildSlackReplyBlocksWithFootnote(
  text: string,
  footnote: string,
): SlackBlock[] | undefined {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_SECTION_TEXT_MAX) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", SLACK_SECTION_TEXT_MAX);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", SLACK_SECTION_TEXT_MAX);
    }
    if (cut <= 0) {
      cut = SLACK_SECTION_TEXT_MAX;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  const sections = chunks.filter((chunk) => chunk.trim().length > 0);
  // Slack allows at most 50 blocks per message; leave room for the footnote.
  if (sections.length === 0 || sections.length > 49) {
    return undefined;
  }
  const blocks: SlackBlock[] = sections.map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk },
  }));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footnote }],
  });
  return blocks;
}

function sanitizeSlackProgressText(text: string, maxLength: number): string {
  // Shared channel sanitization (secrets, control characters, mentions) plus
  // Slack-specific mrkdwn escaping and Slack's ellipsis truncation marker.
  const normalized = sanitizeChannelProgressCore(text)
    .replace(/[<>]/g, "")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
  return truncateChannelProgressText(normalized, maxLength, "…");
}

export function formatSlackProgressCardText(
  status: SlackProgressCardState,
  progressText: string,
): string {
  const safeProgressText = sanitizeSlackProgressText(
    progressText,
    SLACK_PROGRESS_CARD_TEXT_MAX,
  );
  const statusLine =
    status === "processing"
      ? "Letta Code is working on this thread."
      : status === "completed"
        ? "Letta Code finished this turn."
        : status === "cancelled"
          ? "Letta Code stopped this turn."
          : "Letta Code hit an error.";
  return safeProgressText
    ? `${statusLine}\nStatus: ${safeProgressText}`
    : statusLine;
}

/**
 * Live line for text progress mode: the title of the task currently in
 * progress (same vocabulary as the rich card rows), falling back to the most
 * recent task title, then a generic placeholder. ASCII only.
 */
function formatSlackTextProgressLiveText(
  entry: SlackProgressCardEntry,
): string {
  let inProgressTitle: string | undefined;
  let latestTitle: string | undefined;
  for (const task of entry.toolTasksById?.values() ?? []) {
    if (isSlackTransientTask(task)) {
      continue;
    }
    latestTitle = task.title;
    if (task.status === "in_progress") {
      inProgressTitle = task.title;
    }
  }
  const detail = sanitizeSlackProgressText(
    inProgressTitle ?? latestTitle ?? "",
    SLACK_PROGRESS_CARD_TEXT_MAX,
  );
  return detail ? `_Working: ${detail}_` : "_Working..._";
}

/**
 * Live status title for the simple view: the title of the task currently in
 * progress (same vocabulary as card rows), falling back to the most recent
 * task title, then a generic placeholder. Plan titles are plain text.
 */
function formatSlackStatusStreamTitle(entry: SlackProgressCardEntry): string {
  let inProgressTitle: string | undefined;
  let latestTitle: string | undefined;
  for (const task of entry.toolTasksById?.values() ?? []) {
    if (isSlackTransientTask(task)) {
      continue;
    }
    latestTitle = task.title;
    if (task.status === "in_progress") {
      inProgressTitle = task.title;
    }
  }
  const detail = sanitizeSlackProgressText(
    inProgressTitle ?? latestTitle ?? "",
    SLACK_PROGRESS_CARD_TEXT_MAX,
  );
  return detail || "Thinking...";
}

/**
 * Terminal line for text progress mode: the same activity summary the rich
 * card uses for its terminal plan title.
 */
function formatSlackTextProgressTerminalText(
  entry: SlackProgressCardEntry,
): string {
  if (entry.status === "completed") {
    return (
      entry.completionHeaderText?.trim() ||
      formatSlackCompletionPlanTitle(entry)
    );
  }
  if (entry.status === "cancelled") {
    return "Interrupted";
  }
  // A bare "Failed" is zero observability for a genuinely dead turn: carry
  // the turn error into the terminal line whenever we have one.
  const errorLine = sanitizeSlackProgressText(
    entry.errorText ?? "",
    SLACK_STREAM_CHUNK_TEXT_MAX,
  );
  return errorLine ? `Failed — ${errorLine}` : "Failed";
}

function buildSlackLifecycleErrorTaskChunk(
  errorText: string | null | undefined,
): SlackStreamChunk {
  const display = getChannelLifecycleErrorDisplay(errorText);
  const title =
    sanitizeSlackProgressText(display.title, SLACK_STREAM_CHUNK_TEXT_MAX) ||
    "Turn failed";
  const details = sanitizeSlackProgressText(
    display.body,
    SLACK_STREAM_CHUNK_TEXT_MAX,
  );
  return {
    type: "task_update",
    id: SLACK_LIFECYCLE_ERROR_TASK_ID,
    title,
    status: "error",
    details,
  };
}

function formatSlackControlRequestBlocks(
  event: ChannelControlRequestEvent,
): SlackBlock[] | undefined {
  if (event.kind !== "generic_tool_approval") {
    return undefined;
  }

  const toolName =
    sanitizeSlackProgressText(
      formatSlackToolNameForDisplay(event.toolName),
      80,
    ) || "tool";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed*\nRun \`${toolName}\`?`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Reply `approve` to allow it, or reply with feedback to deny.",
        },
      ],
    },
  ];
}

function buildTerminalSlackStreamChunks(
  entry: SlackProgressCardEntry,
  terminalTaskStatus: SlackStreamTaskStatus,
  finalErrorChunk?: SlackStreamChunk,
): SlackStreamChunk[] {
  // Deduplicate pending chunks by task ID, keeping only the latest.
  // pendingStreamChunks can accumulate multiple updates for the same task
  // (e.g. in_progress then complete) and Slack accumulates details across
  // chunks with the same id, so duplicates cause repeated detail text.
  const rawPending = [...(entry.pendingStreamChunks ?? [])];
  // Also include ALL tasks from toolTasksById so the stopStream sends
  // the full final state — appendStream may not render in real-time,
  // so the block might only populate at stopStream.
  for (const task of entry.toolTasksById?.values() ?? []) {
    if (isSlackTransientTask(task)) {
      if (isSlackTurnActiveTaskId(task.id)) {
        // Slack keeps prior task rows visible at stopStream time. Close the
        // transient liveness row explicitly so a finished stream does not show
        // a warning/error just because "Still working" was still in progress.
        rawPending.push(
          toSlackTaskUpdateChunk({
            ...task,
            title:
              entry.status === "completed"
                ? "Completed"
                : entry.status === "cancelled"
                  ? "Stopped"
                  : "Failed",
            status: terminalTaskStatus,
          }),
        );
      }
      continue;
    }
    // Preserve rows that already reached a real terminal state: completed
    // rows always, and errored rows unless the turn itself completed (a
    // completed turn intentionally downgrades stale error rows). Keyed on the
    // turn outcome, not terminalTaskStatus, so cancelled turns (which now
    // close remaining rows as "complete"/"Stopped") keep genuine tool
    // failures visible instead of repainting them green.
    const shouldPreserveTerminalTask =
      task.status === "complete" ||
      (task.status === "error" && entry.status !== "completed");
    const terminalTask = shouldPreserveTerminalTask
      ? task
      : {
          ...task,
          title: formatSlackTaskTitleForStatus(task, terminalTaskStatus),
          status: terminalTaskStatus,
        };
    rawPending.push(toSlackTaskUpdateChunk(terminalTask));
    if (!shouldPreserveTerminalTask) {
      entry.toolTasksById?.set(task.id, terminalTask);
    }
  }
  if (finalErrorChunk) {
    rawPending.push(finalErrorChunk);
  }
  const chunks = compactSlackStreamChunks(rawPending, entry);
  if (
    entry.status !== "processing" ||
    chunks.some((chunk) => chunk.type === "task_update")
  ) {
    chunks.push(buildSlackPlanUpdateChunk(entry));
  }
  return chunks;
}

/**
 * Render the terminal state as a single plain message block for a stream
 * Slack has already taken out of streaming state (expired or externally
 * stopped). stopStream no-ops with `message_not_in_streaming_state` on such
 * messages, so the rich close cannot be delivered.
 *
 * Deliberately minimal: just the terminal plan title (the same summary the
 * rich card would have shown, e.g. "Ran 3 commands, wrote a file") plus the
 * chat footnote. The previous per-task ":white_check_mark: title — details"
 * dump duplicated rows the card already displayed, coalesced into the
 * preceding reply as a wall of text, and had truncation/encoding artifacts.
 */
function buildSlackDeadStreamRewrite(
  entry: SlackProgressCardEntry,
  chunks: SlackStreamChunk[],
): { text: string; blocks: SlackBlock[] } {
  const planTitle = chunks.reduce<string | null>(
    (latest, chunk) => (chunk.type === "plan_update" ? chunk.title : latest),
    null,
  );
  const headerText =
    sanitizeSlackProgressText(planTitle ?? "", SLACK_STREAM_CHUNK_TEXT_MAX) ||
    formatSlackProgressCardText(entry.status, entry.latestText);
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headerText}*` },
    },
  ];
  // Error outcomes keep their reason: the terminal rewrite is the only
  // surface left once the stream is dead, so a red close with no error text
  // reads as an unexplained agent death.
  const errorDetails = chunks.reduce<string | undefined>(
    (found, chunk) =>
      chunk.type === "task_update" && chunk.status === "error" && chunk.details
        ? chunk.details
        : found,
    entry.errorText,
  );
  const errorLine =
    entry.status === "error"
      ? sanitizeSlackProgressText(
          errorDetails ?? "",
          SLACK_STREAM_CHUNK_TEXT_MAX,
        )
      : "";
  if (errorLine) {
    blocks.splice(1, 0, {
      type: "section",
      text: { type: "mrkdwn", text: errorLine },
    });
  }
  const footnote = buildSlackChatFootnote(entry.source);
  if (footnote) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: footnote }],
    });
  }
  return {
    text: errorLine ? `${headerText} — ${errorLine}` : headerText,
    blocks,
  };
}

function isDuplicateSkillTaskDetails(
  toolName: string | undefined,
  title: string,
  details: string | undefined,
): boolean {
  return Boolean(
    toolName &&
      details &&
      isSkillToolName(toolName) &&
      title === `Skill: ${details}`,
  );
}

function shouldIncludeSlackTaskDetails(task: SlackProgressToolTask): boolean {
  return Boolean(
    task.details &&
      !isDuplicateSkillTaskDetails(task.toolName, task.title, task.details) &&
      (!task.toolTitle ||
        task.wasError ||
        (task.toolName && isSkillToolName(task.toolName))) &&
      !(
        task.toolName &&
        isShellTool(task.toolName) &&
        task.title === task.details
      ),
  );
}

function toSlackTaskUpdateChunk(task: SlackProgressToolTask): SlackStreamChunk {
  const {
    kind: _kind,
    toolName: _toolName,
    toolTitle: _toolTitle,
    wasError: _wasError,
    details,
    ...chunkTask
  } = task;
  const shouldIncludeDetails = shouldIncludeSlackTaskDetails(task);
  return {
    type: "task_update",
    ...chunkTask,
    title: sanitizeSlackProgressText(
      chunkTask.title,
      SLACK_STREAM_CHUNK_TEXT_MAX,
    ),
    ...(shouldIncludeDetails
      ? {
          details: sanitizeSlackProgressText(
            details ?? "",
            SLACK_STREAM_CHUNK_TEXT_MAX,
          ),
        }
      : {}),
  };
}

function compactSlackStreamChunks(
  rawChunks: SlackStreamChunk[],
  entry: SlackProgressCardEntry,
): SlackStreamChunk[] {
  const lastByTaskId = new Map<string, number>();
  const latestDetailsByTaskId = new Map<string, string>();

  rawChunks.forEach((chunk, i) => {
    if (chunk.type !== "task_update") {
      return;
    }
    lastByTaskId.set(chunk.id, i);
    if (isNonEmptyString(chunk.details)) {
      latestDetailsByTaskId.set(chunk.id, chunk.details);
    }
  });

  const compacted = rawChunks.flatMap((chunk, i): SlackStreamChunk[] => {
    if (chunk.type !== "task_update") {
      return [chunk];
    }
    if (lastByTaskId.get(chunk.id) !== i) {
      return [];
    }

    const pendingDetails = chunk.details ?? latestDetailsByTaskId.get(chunk.id);
    if (!pendingDetails) {
      return [chunk];
    }
    if (entry.sentTaskDetailsById?.get(chunk.id) === pendingDetails) {
      const { details: _details, ...chunkWithoutDetails } = chunk;
      return [chunkWithoutDetails];
    }
    if (chunk.details === pendingDetails) {
      return [chunk];
    }
    return [{ ...chunk, details: pendingDetails }];
  });
  return compacted;
}

function rememberSlackStreamTaskDetails(
  entry: SlackProgressCardEntry,
  chunks: SlackStreamChunk[],
): void {
  for (const chunk of chunks) {
    if (chunk.type !== "task_update" || !isNonEmptyString(chunk.details)) {
      continue;
    }
    entry.sentTaskDetailsById ??= new Map();
    entry.sentTaskDetailsById.set(chunk.id, chunk.details);
  }
}

function isSlackToolActionProgress(update: ChannelTurnProgressEvent): boolean {
  return (
    update.kind === "tool" ||
    update.kind === "approval" ||
    update.kind === "command" ||
    update.kind === "thinking" ||
    update.kind === "responding"
  );
}

function isSlackMessageChannelToolName(toolName: string): boolean {
  return toolName.toLowerCase() === "messagechannel";
}

function isSlackHiddenToolName(toolName: string): boolean {
  return isSlackMessageChannelToolName(toolName);
}

function isSlackTurnActiveTaskId(taskId: string): boolean {
  return (
    taskId === SLACK_TURN_ACTIVE_TASK_ID ||
    taskId.startsWith(`${SLACK_TURN_ACTIVE_TASK_ID}_`)
  );
}

function isSlackTransientTask(task: SlackProgressToolTask): boolean {
  if (task.id === SLACK_CHANNEL_RESPONSE_TASK_ID) {
    return true;
  }
  return isSlackTurnActiveTaskId(task.id) && !task.toolName && !task.toolTitle;
}

function isSlackMessageChannelToolUpdate(
  entry: SlackProgressCardEntry | undefined,
  update: ChannelTurnProgressEvent,
): boolean {
  return Boolean(
    update.kind === "tool" &&
      ((update.toolName && isSlackMessageChannelToolName(update.toolName)) ||
        (update.toolCallId &&
          entry?.hiddenToolCallIds?.has(update.toolCallId))),
  );
}

function shouldShowSlackChannelResponseProgress(
  _entry: SlackProgressCardEntry | undefined,
  _update: ChannelTurnProgressEvent,
): _entry is SlackProgressCardEntry {
  // The final Slack message is already visible as a normal reply. Rendering
  // MessageChannel as a task row makes "Responded" appear mid-card when the
  // agent sends a status update and then keeps working.
  return false;
}

function formatSlackToolNameForDisplay(toolName: string): string {
  if (isTaskTool(toolName)) {
    return "Subagent";
  }
  return getDisplayToolName(toolName);
}

/**
 * Single source of truth for tool task titles. Titles are always derived
 * from the raw tool name plus the task status, never re-parsed from
 * previously rendered display strings.
 */
function formatSlackToolTaskTitle(
  toolName: string,
  status: SlackStreamTaskStatus,
  details?: string,
): string {
  if (isSkillToolName(toolName)) {
    return details ? `Skill: ${details}` : "Skill";
  }
  if (isTaskTool(toolName)) {
    return "Subagent";
  }
  if (isShellTool(toolName)) {
    if (details) {
      return details;
    }
    // "Ran" also covers errors: the command did run and finish; the row's
    // error status conveys the failure.
    return status === "complete" || status === "error" ? "Ran" : "Running";
  }
  if (toolName === "TaskOutput") {
    return status === "complete"
      ? "Checked task output"
      : "Checking task output";
  }
  if (toolName === "BashOutput") {
    return status === "complete"
      ? "Checked shell output"
      : "Checking shell output";
  }
  if (isWebSearchTool(toolName)) {
    if (status === "complete") {
      return "Searched the web";
    }
    if (status === "error") {
      return "Attempted to search the web";
    }
    return "Searching the web";
  }
  return getDisplayToolName(toolName);
}

function formatSlackTaskTitleForStatus(
  task: SlackProgressToolTask,
  status: SlackStreamTaskStatus,
): string {
  if (task.kind === "responding") {
    return formatSlackChannelResponseTitle(status);
  }
  if (task.toolTitle) {
    return task.toolTitle;
  }
  if (task.toolName) {
    return formatSlackToolTaskTitle(task.toolName, status, task.details);
  }
  return task.title;
}

function rememberSlackToolName(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent | undefined,
): void {
  if (!update?.toolCallId) {
    return;
  }
  if (update.toolName && isSlackHiddenToolName(update.toolName)) {
    entry.hiddenToolCallIds ??= new Set();
    entry.hiddenToolCallIds.add(update.toolCallId);
    entry.toolNamesByCallId?.delete(update.toolCallId);
    entry.toolDetailsByCallId?.delete(update.toolCallId);
    entry.toolTitlesByCallId?.delete(update.toolCallId);
    return;
  }
  if (update.toolName) {
    entry.toolNamesByCallId ??= new Map();
    entry.toolNamesByCallId.set(update.toolCallId, update.toolName);
  }
  if (update.toolDetails) {
    entry.toolDetailsByCallId ??= new Map();
    entry.toolDetailsByCallId.set(update.toolCallId, update.toolDetails);
  }
  if (update.toolTitle) {
    entry.toolTitlesByCallId ??= new Map();
    entry.toolTitlesByCallId.set(update.toolCallId, update.toolTitle);
  }
}

function isSlackHiddenToolUpdate(
  entry: SlackProgressCardEntry | undefined,
  update: ChannelTurnProgressEvent,
): boolean {
  return Boolean(
    (update.toolName && isSlackHiddenToolName(update.toolName)) ||
      (update.toolCallId && entry?.hiddenToolCallIds?.has(update.toolCallId)),
  );
}

function resolveSlackToolActionName(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
  details?: string,
): string | null {
  if (update.toolCallId && entry.hiddenToolCallIds?.has(update.toolCallId)) {
    return null;
  }
  const approvalPrefix = update.kind === "approval" ? "Approval needed: " : "";
  const toolTitle =
    update.toolTitle ??
    (update.toolCallId
      ? entry.toolTitlesByCallId?.get(update.toolCallId)
      : undefined);
  if (toolTitle) {
    return sanitizeSlackProgressText(
      `${approvalPrefix}${toolTitle}`,
      SLACK_STREAM_CHUNK_TEXT_MAX,
    );
  }
  const toolName =
    update.toolName ??
    (update.toolCallId
      ? entry.toolNamesByCallId?.get(update.toolCallId)
      : undefined);
  if (toolName) {
    if (isSlackHiddenToolName(toolName)) {
      return null;
    }
    const title = formatSlackToolTaskTitle(
      toolName,
      toSlackStreamTaskStatus(update),
      details,
    );
    return sanitizeSlackProgressText(
      `${approvalPrefix}${title}`,
      SLACK_STREAM_CHUNK_TEXT_MAX,
    );
  }
  if (update.kind === "tool") {
    return null;
  }
  const raw = update.command
    ? formatSlackToolNameForDisplay(update.command)
    : update.kind === "approval"
      ? "Tool approval"
      : null;
  if (!raw) {
    return null;
  }
  return sanitizeSlackProgressText(raw, SLACK_STREAM_CHUNK_TEXT_MAX);
}

function resolveSlackToolActionDetails(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
): string | undefined {
  if (update.kind === "approval") {
    return undefined;
  }
  const toolName =
    update.toolName ??
    (update.toolCallId
      ? entry.toolNamesByCallId?.get(update.toolCallId)
      : undefined);
  const toolTitle =
    update.toolTitle ??
    (update.toolCallId
      ? entry.toolTitlesByCallId?.get(update.toolCallId)
      : undefined);
  if (
    toolTitle &&
    update.state !== "error" &&
    !(toolName && isSkillToolName(toolName))
  ) {
    return undefined;
  }
  const rememberedDetails = update.toolCallId
    ? entry.toolDetailsByCallId?.get(update.toolCallId)
    : undefined;
  // Error-output previews only ever render as detail text under the row
  // title; toolDetails/toolTitle stay argument-derived so tool output can
  // never become a header (LET-9509).
  const details =
    (update.state === "error" ? update.errorDetails : undefined) ??
    update.toolDetails ??
    rememberedDetails;
  if (!details) {
    return undefined;
  }
  const sanitized = sanitizeSlackProgressText(
    details,
    SLACK_STREAM_CHUNK_TEXT_MAX,
  );
  return sanitized || undefined;
}

function pluralizeTool(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

type SlackCompletionActivity =
  | "command"
  | "shell_output"
  | "task_output"
  | "read_file"
  | "wrote_file"
  | "updated_file"
  | "searched_files"
  | "searched_web"
  | "used_skill"
  | "used_subagent"
  | "used_tool";

function getSlackCompletionActivity(
  task: SlackProgressToolTask,
): SlackCompletionActivity | null {
  if (isSlackTransientTask(task) || task.id === SLACK_LIFECYCLE_ERROR_TASK_ID) {
    return null;
  }
  const toolName = task.toolName;
  if (!toolName) {
    return "used_tool";
  }
  if (isShellTool(toolName)) {
    return "command";
  }
  if (toolName === "BashOutput") {
    return "shell_output";
  }
  if (toolName === "TaskOutput") {
    return "task_output";
  }
  if (isFileReadTool(toolName)) {
    return "read_file";
  }
  if (isFileWriteTool(toolName)) {
    return "wrote_file";
  }
  if (isFileEditTool(toolName)) {
    return "updated_file";
  }
  if (isSearchTool(toolName) || isGlobTool(toolName)) {
    return "searched_files";
  }
  if (isWebSearchTool(toolName)) {
    return "searched_web";
  }
  if (isSkillToolName(toolName)) {
    return "used_skill";
  }
  if (isTaskTool(toolName)) {
    return "used_subagent";
  }
  return "used_tool";
}

function pluralizeActivity(
  count: number,
  singular: string,
  plural: string,
): string {
  return count === 1 ? singular : plural.replace("{count}", String(count));
}

function formatSlackCompletionActivity(
  activity: SlackCompletionActivity,
  count: number,
): string {
  switch (activity) {
    case "command":
      return pluralizeActivity(count, "ran a command", "ran {count} commands");
    case "shell_output":
      return pluralizeActivity(
        count,
        "checked shell output",
        "checked shell output {count} times",
      );
    case "task_output":
      return pluralizeActivity(
        count,
        "checked task output",
        "checked task output {count} times",
      );
    case "read_file":
      return pluralizeActivity(count, "read a file", "read {count} files");
    case "wrote_file":
      return pluralizeActivity(count, "wrote a file", "wrote {count} files");
    case "updated_file":
      return pluralizeActivity(
        count,
        "updated a file",
        "updated {count} files",
      );
    case "searched_files":
      return pluralizeActivity(
        count,
        "searched files",
        "searched files {count} times",
      );
    case "searched_web":
      return pluralizeActivity(
        count,
        "searched the web",
        "searched the web {count} times",
      );
    case "used_skill":
      return pluralizeActivity(count, "used a skill", "used {count} skills");
    case "used_subagent":
      return pluralizeActivity(
        count,
        "used a subagent",
        "used {count} subagents",
      );
    case "used_tool":
      return pluralizeActivity(count, "used a tool", "used {count} tools");
  }
}

function formatSlackCompletionPlanTitle(entry: SlackProgressCardEntry): string {
  const activityCounts = new Map<SlackCompletionActivity, number>();
  for (const task of entry.toolTasksById?.values() ?? []) {
    const activity = getSlackCompletionActivity(task);
    if (!activity) {
      continue;
    }
    activityCounts.set(activity, (activityCounts.get(activity) ?? 0) + 1);
  }
  const summary = Array.from(activityCounts.entries())
    .map(([activity, count]) => formatSlackCompletionActivity(activity, count))
    .join(", ");
  const title = summary
    ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}`
    : "Completed";
  return (
    sanitizeSlackProgressText(title, SLACK_PROGRESS_CARD_TEXT_MAX) ||
    "Completed"
  );
}

function buildSlackPlanUpdateChunk(
  entry: SlackProgressCardEntry,
): SlackStreamChunk {
  const tasks = Array.from(entry.toolTasksById?.values() ?? []).filter(
    (task) => !isSlackTransientTask(task),
  );
  const approvalCount = tasks.filter(
    (task) => task.kind === "approval" && task.status === "pending",
  ).length;
  if (approvalCount > 0) {
    return {
      type: "plan_update",
      title:
        approvalCount === 1
          ? "Approval needed"
          : `${approvalCount} approvals needed`,
    };
  }

  const runningTasks = tasks.filter(
    (task) => task.status === "in_progress" || task.status === "pending",
  );
  if (tasks.length === 0 && entry.reasoningActive) {
    return {
      type: "plan_update",
      title: "Thinking",
    };
  }
  if (runningTasks.length === 1) {
    return {
      type: "plan_update",
      title: runningTasks[0]?.title ?? "Working",
    };
  }
  if (runningTasks.length > 1) {
    return {
      type: "plan_update",
      title: `Running ${pluralizeTool(runningTasks.length)}`,
    };
  }

  if (entry.status === "processing") {
    return {
      type: "plan_update",
      title: entry.reasoningActive ? "Thinking" : "Working",
    };
  }

  if (entry.status === "error") {
    return {
      type: "plan_update",
      title: "Failed",
    };
  }
  if (entry.status === "cancelled") {
    return {
      type: "plan_update",
      title: "Interrupted",
    };
  }
  if (entry.status === "completed") {
    return {
      type: "plan_update",
      title: formatSlackCompletionPlanTitle(entry),
    };
  }

  const completeCount = tasks.filter(
    (task) => task.status === "complete",
  ).length;
  return {
    type: "plan_update",
    title: completeCount > 0 ? "Completed" : "Working",
  };
}

function reconcileSlackTurnActiveTask(
  entry: SlackProgressCardEntry,
): SlackStreamChunk[] {
  entry.toolTasksById ??= new Map();
  const hasVisibleInProgressTask = Array.from(
    entry.toolTasksById.values(),
  ).some(
    (task) => !isSlackTransientTask(task) && task.status === "in_progress",
  );
  if (hasVisibleInProgressTask) {
    return [];
  }

  const existingId = entry.placeholderTaskId;
  const existing = existingId ? entry.toolTasksById.get(existingId) : undefined;
  if (existing && isSlackTransientTask(existing)) {
    return [];
  }

  const sequence = entry.placeholderTaskSequence ?? 0;
  const id =
    sequence === 0
      ? SLACK_TURN_ACTIVE_TASK_ID
      : `${SLACK_TURN_ACTIVE_TASK_ID}_${sequence}`;
  entry.placeholderTaskSequence = sequence + 1;
  entry.placeholderTaskId = id;

  const task: SlackProgressToolTask = {
    id,
    kind: "thinking",
    title: "Still working",
    status: "in_progress",
  };
  entry.toolTasksById.set(task.id, task);
  return [toSlackTaskUpdateChunk(task)];
}

function resolveSlackToolActionTaskId(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
): string | null {
  if (update.toolCallId) {
    const existingTaskId = entry.toolTaskIdsByCallId?.get(update.toolCallId);
    if (existingTaskId) {
      return existingTaskId;
    }

    const placeholderId = entry.placeholderTaskId;
    const placeholder = placeholderId
      ? entry.toolTasksById?.get(placeholderId)
      : undefined;
    if (placeholderId && placeholder && isSlackTransientTask(placeholder)) {
      entry.toolTaskIdsByCallId ??= new Map();
      entry.toolTaskIdsByCallId.set(update.toolCallId, placeholderId);
      entry.placeholderTaskId = undefined;
      return placeholderId;
    }
  }

  const raw =
    update.toolCallId ??
    update.command ??
    update.toolName ??
    (update.kind === "approval" ? "approval" : null);
  if (!raw) {
    return null;
  }
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_");
  const trimmed = safe.replace(/^_+|_+$/g, "").slice(0, 80);
  const taskId = `task_${trimmed || "tool"}`;
  if (update.toolCallId) {
    entry.toolTaskIdsByCallId ??= new Map();
    entry.toolTaskIdsByCallId.set(update.toolCallId, taskId);
  }
  return taskId;
}

function toSlackStreamTaskStatus(
  update: ChannelTurnProgressEvent,
): SlackStreamTaskStatus {
  if (update.state === "error") {
    // Tool-level failures are still part of the work history; the whole Slack
    // progress card should only show an error state when the turn itself fails.
    return update.kind === "tool" ? "complete" : "error";
  }
  if (update.state === "completed") {
    return "complete";
  }
  if (update.state === "waiting") {
    return "pending";
  }
  return "in_progress";
}

function formatSlackChannelResponseTitle(
  status: SlackStreamTaskStatus,
): string {
  if (status === "complete") {
    return "Responded";
  }
  if (status === "error") {
    return "Response failed";
  }
  return "Responding";
}

function buildSlackChannelResponseProgressChunks(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
): SlackStreamChunk[] {
  const status = toSlackStreamTaskStatus(update);
  const title = formatSlackChannelResponseTitle(status);
  const prevTask = entry.toolTasksById?.get(SLACK_CHANNEL_RESPONSE_TASK_ID);
  if (prevTask?.title === title && prevTask.status === status) {
    return [];
  }

  const task: SlackProgressToolTask = {
    id: SLACK_CHANNEL_RESPONSE_TASK_ID,
    kind: "responding",
    title,
    status,
  };
  entry.toolTasksById ??= new Map();
  entry.reasoningActive = false;
  entry.toolTasksById.set(task.id, task);
  const turnActiveChunks = reconcileSlackTurnActiveTask(entry);

  return [
    buildSlackPlanUpdateChunk(entry),
    ...(status === "complete" || status === "error" ? [] : turnActiveChunks),
    {
      type: "task_update",
      id: task.id,
      title: task.title,
      status: task.status,
    },
    ...(status === "complete" || status === "error" ? turnActiveChunks : []),
  ];
}

function buildSlackStreamProgressChunks(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
): SlackStreamChunk[] {
  // Handle reasoning/replying events as plan/header state, not task rows.
  if (update.kind === "thinking" || update.kind === "responding") {
    const reasoningActive = update.state !== "completed";
    if (entry.reasoningActive === reasoningActive) {
      return [];
    }
    entry.reasoningActive = reasoningActive;
    // Do not create a stream for reasoning-only turns before the Slack card is
    // visible. If a stream already exists, keep a concrete bottom row so the
    // card does not look done while the run is still thinking between tools.
    return entry.mode === "stream"
      ? [
          buildSlackPlanUpdateChunk(entry),
          ...reconcileSlackTurnActiveTask(entry),
        ]
      : [];
  }

  if (isSlackMessageChannelToolUpdate(entry, update)) {
    return buildSlackChannelResponseProgressChunks(entry, update);
  }

  // Slack replaces task rows that reuse an id, so visible tool calls need
  // stable per-call task ids to preserve parallel tool history in the card.
  const id = resolveSlackToolActionTaskId(entry, update);
  if (!id) {
    return [];
  }
  const status = toSlackStreamTaskStatus(update);
  const resolvedDetails = resolveSlackToolActionDetails(entry, update);
  const sentDetails = entry.sentTaskDetailsById?.get(id);
  // Slack task streams append changed details for a task instead of replacing
  // them. Once details have rendered, keep that string stable for the task.
  const details =
    sentDetails && resolvedDetails && sentDetails !== resolvedDetails
      ? sentDetails
      : resolvedDetails;
  // Titles only ever derive from argument summaries — resolved details can
  // carry an error-output preview, which must never become a header
  // (LET-9509).
  const titleDetails =
    update.toolDetails ??
    (update.toolCallId
      ? entry.toolDetailsByCallId?.get(update.toolCallId)
      : undefined);
  const title = resolveSlackToolActionName(entry, update, titleDetails);
  if (!title) {
    return [];
  }

  // Skip the entire appendStream call if nothing has changed for this task.
  // Slack's streaming API re-renders details on every appendStream, so even
  // omitting the details field from the chunk doesn't prevent duplication.
  const prevTask = entry.toolTasksById?.get(id);
  // Don't downgrade a completed task to error — the server sometimes sends
  // both a "completed" and an "error" tool_return for the same call; the
  // completed event arrives first and is the reliable one.
  if (prevTask && prevTask.status === "complete" && status === "error") {
    return [];
  }
  if (prevTask && prevTask.status === "complete" && status === "in_progress") {
    return [];
  }
  if (
    prevTask &&
    prevTask.title === title &&
    prevTask.status === status &&
    (prevTask.details ?? "") === (details ?? "")
  ) {
    return [];
  }
  const toolName =
    update.toolName ??
    (update.toolCallId
      ? entry.toolNamesByCallId?.get(update.toolCallId)
      : undefined);
  const toolTitle =
    update.toolTitle ??
    (update.toolCallId
      ? entry.toolTitlesByCallId?.get(update.toolCallId)
      : undefined);
  const task: SlackProgressToolTask = {
    id,
    kind: update.kind,
    ...(toolName ? { toolName } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    title,
    status,
    ...(details ? { details } : {}),
    ...(update.state === "error" ? { wasError: true } : {}),
  };
  entry.toolTasksById ??= new Map();
  const chunks: SlackStreamChunk[] = [];
  entry.reasoningActive = false;

  entry.toolTasksById.set(id, task);

  // Only include details in the chunk when they actually changed.
  // Slack's streaming API accumulates the details field across
  // appendStream calls with the same task id, so re-sending the same
  // details when only the status changes causes them to duplicate.
  const detailsChanged =
    !prevTask || (prevTask.details ?? "") !== (details ?? "");
  const shouldIncludeTaskDetails =
    details &&
    (detailsChanged || status !== "in_progress") &&
    !isDuplicateSkillTaskDetails(toolName, title, details) &&
    (!toolTitle ||
      update.state === "error" ||
      (toolName && isSkillToolName(toolName))) &&
    !(toolName && isShellTool(toolName) && title === details);

  chunks.push(buildSlackPlanUpdateChunk(entry));
  chunks.push({
    type: "task_update" as const,
    id: task.id,
    title: task.title,
    status: task.status,
    ...(shouldIncludeTaskDetails ? { details } : {}),
  });
  if (status === "complete" || status === "error") {
    chunks.push(...reconcileSlackTurnActiveTask(entry));
  }

  return chunks;
}

function resolveSlackLifecycleProgressText(outcome: ChannelTurnOutcome): {
  status: SlackProgressCardState;
  text: string;
} {
  if (outcome === "completed") {
    return { status: "completed", text: "Completed" };
  }
  if (outcome === "cancelled") {
    return { status: "cancelled", text: "Interrupted" };
  }
  return { status: "error", text: "Failed" };
}

/**
 * Tracks Slack channel threads the agent has sent messages to, so that
 * inbound replies in those threads are auto-routed without requiring an
 * explicit @mention. Slack message timestamps are scoped to a channel in Slack
 * APIs, so the key intentionally includes both the channel id and thread id.
 * Entries expire after `SLACK_AGENT_THREAD_TTL_MS` and the set is capped at
 * `SLACK_AGENT_THREAD_MAX`.
 */
export type AgentThreadTracker = {
  remember: (channelId: string, threadId: string) => void;
  has: (channelId: string, threadId: string) => boolean;
  clear: () => void;
};

type AgentThreadTrackerOptions = {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

function buildAgentThreadTrackerKey(
  channelId: string,
  threadId: string,
): string {
  return `${channelId}:${threadId}`;
}

export function createAgentThreadTracker(
  options: AgentThreadTrackerOptions = {},
): AgentThreadTracker {
  const threadIds = new Map<string, number>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SLACK_AGENT_THREAD_TTL_MS;
  const maxEntries = options.maxEntries ?? SLACK_AGENT_THREAD_MAX;

  function prune(currentTime: number = now()): void {
    for (const [key, expiresAt] of threadIds) {
      if (expiresAt <= currentTime) {
        threadIds.delete(key);
      }
    }
    if (threadIds.size <= maxEntries) {
      return;
    }
    const sorted = Array.from(threadIds.entries()).sort((a, b) => a[1] - b[1]);
    const overflow = threadIds.size - maxEntries;
    for (let i = 0; i < overflow; i += 1) {
      const entry = sorted[i];
      if (entry) {
        threadIds.delete(entry[0]);
      }
    }
  }

  return {
    remember(channelId: string, threadId: string): void {
      const currentTime = now();
      prune(currentTime);
      threadIds.set(
        buildAgentThreadTrackerKey(channelId, threadId),
        currentTime + ttlMs,
      );
    },
    has(channelId: string, threadId: string): boolean {
      prune();
      return threadIds.has(buildAgentThreadTrackerKey(channelId, threadId));
    },
    clear(): void {
      threadIds.clear();
    },
  };
}

function resolveUploadMimeType(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    default:
      return undefined;
  }
}

async function uploadSlackFile(
  slackClient: SlackWriteClient,
  msg: OutboundChannelMessage,
): Promise<{ messageId: string }> {
  if (!msg.mediaPath) {
    throw new Error("mediaPath is required for Slack file uploads.");
  }

  const buffer = await readFile(msg.mediaPath);
  const uploadFileName = msg.fileName ?? basename(msg.mediaPath);
  const uploadTitle = msg.title ?? uploadFileName;
  const uploadMimeType = resolveUploadMimeType(uploadFileName);
  const uploadUrlResp = await slackClient.files.getUploadURLExternal({
    filename: uploadFileName,
    length: buffer.length,
  });

  if (
    !uploadUrlResp.ok ||
    !uploadUrlResp.upload_url ||
    !uploadUrlResp.file_id
  ) {
    throw new Error(
      `Failed to get Slack upload URL: ${uploadUrlResp.error ?? "unknown error"}`,
    );
  }

  const uploadResp = await fetch(uploadUrlResp.upload_url, {
    method: "POST",
    ...(uploadMimeType ? { headers: { "Content-Type": uploadMimeType } } : {}),
    body: buffer,
  });
  if (!uploadResp.ok) {
    throw new Error(`Failed to upload Slack file: HTTP ${uploadResp.status}`);
  }

  const threadTs = resolveSlackOutboundThreadTs({
    chatId: msg.chatId,
    threadId: msg.threadId,
    replyToMessageId: msg.replyToMessageId,
  });

  const completeResp = await slackClient.files.completeUploadExternal({
    files: [{ id: uploadUrlResp.file_id, title: uploadTitle }],
    channel_id: msg.chatId,
    ...(msg.text.trim() ? { initial_comment: msg.text } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  if (!completeResp.ok) {
    throw new Error(
      `Failed to complete Slack upload: ${completeResp.error ?? "unknown error"}`,
    );
  }

  return { messageId: uploadUrlResp.file_id };
}

function resolveSlackUserDisplayName(userInfo: unknown): string | undefined {
  const user = asRecord(asRecord(userInfo)?.user);
  const profile = asRecord(user?.profile);
  return firstNonEmptyString(
    profile?.display_name,
    profile?.real_name,
    user?.name,
  );
}

function truncateSlackThreadLabel(text: string, maxLength = 80): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildSlackThreadLabel(
  msg: InboundChannelMessage,
  starterText?: string,
): string | undefined {
  const roomLabel =
    msg.chatType === "channel" &&
    isNonEmptyString(msg.chatLabel) &&
    msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";
  const preview = truncateSlackThreadLabel(starterText ?? msg.text);
  const threadLabel =
    msg.chatType === "direct" ? "Slack DM thread" : "Slack thread";
  if (preview) {
    return `${threadLabel}${roomLabel}: ${preview}`;
  }
  return roomLabel
    ? `${threadLabel}${roomLabel}`
    : `${threadLabel} ${msg.chatId}`;
}

function buildSlackChannelContextLabel(
  msg: InboundChannelMessage,
): string | undefined {
  if (msg.chatType !== "channel") {
    return undefined;
  }

  const roomLabel =
    isNonEmptyString(msg.chatLabel) && msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";

  return roomLabel
    ? `Slack channel context${roomLabel} before thread start`
    : `Slack channel context before thread start`;
}

export async function resolveSlackAccountDisplayName(
  botToken: string,
  appToken: string,
): Promise<string | undefined> {
  const bolt = await loadSlackBoltModule();
  const App = resolveSlackAppConstructor(bolt);
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });
  const auth = await app.client.auth.test({ token: botToken });
  if (isNonEmptyString(auth.user_id)) {
    try {
      const userInfo = await app.client.users.info({
        token: botToken,
        user: auth.user_id,
      });
      const displayName = resolveSlackUserDisplayName(userInfo);
      if (displayName) {
        return displayName;
      }
    } catch {}
  }
  return isNonEmptyString(auth.user) ? auth.user : undefined;
}

const APP_MENTION_RETRY_TTL_MS = 60_000;

type SlackDebounceSource = "message" | "app_mention";

type SlackDebounceRawInput = {
  channel: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  parent_user_id?: string;
  user?: string;
  bot_id?: string;
};

/**
 * Build the key used to group inbound Slack messages for debounced stacking.
 *
 * Keying mirrors openclaw (four cases):
 *  - DM → channel-scoped (short DMs from same user stack together)
 *  - Thread reply (`thread_ts` set) → thread-scoped
 *  - Probable thread reply (`parent_user_id` set, no `thread_ts` yet — Slack
 *    sometimes emits these before thread resolution completes) → "maybe-thread"
 *  - Top-level channel message → message-ts-scoped (each top-level post is
 *    its own potential thread-starter; don't merge across posts)
 *
 * Returns `null` when there is no identifiable sender, which forces the
 * debouncer to dispatch the item immediately.
 */
export function buildSlackDebounceKey(
  rawMessage: SlackDebounceRawInput,
  accountId: string,
): string | null {
  const senderId = rawMessage.user ?? rawMessage.bot_id ?? null;
  if (!senderId) return null;
  const messageTs = rawMessage.ts ?? rawMessage.event_ts;
  const isDm = rawMessage.channel.startsWith("D");
  const scope = rawMessage.thread_ts
    ? `${rawMessage.channel}:${rawMessage.thread_ts}`
    : rawMessage.parent_user_id && messageTs
      ? `${rawMessage.channel}:maybe-thread:${messageTs}`
      : messageTs && !isDm
        ? `${rawMessage.channel}:${messageTs}`
        : rawMessage.channel;
  return `slack:${accountId}:${scope}:${senderId}`;
}

/**
 * Build the key that groups top-level (non-thread) channel messages from the
 * same sender. Used to pre-flush pending debounced buffers when a
 * non-debounceable message (e.g. one with an attachment) arrives for the
 * same conversation, so ordering is preserved.
 *
 * DMs and thread replies intentionally return `null` — their debounce keys
 * already naturally align without this pre-flush step.
 */
export function buildTopLevelSlackConversationKey(
  rawMessage: SlackDebounceRawInput,
  accountId: string,
): string | null {
  if (rawMessage.thread_ts || rawMessage.parent_user_id) return null;
  if (rawMessage.channel.startsWith("D")) return null;
  const senderId = rawMessage.user ?? rawMessage.bot_id;
  if (!senderId) return null;
  return `slack:${accountId}:${rawMessage.channel}:${senderId}`;
}

export function resolveSlackInboundDebounceMs(
  config: Pick<SlackChannelAccount, "inboundDebounceMs">,
): number {
  const raw = process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const envOverride = Number(raw);
    if (Number.isFinite(envOverride) && envOverride >= 0) {
      return Math.trunc(envOverride);
    }
  }
  const fromConfig = config.inboundDebounceMs;
  if (
    typeof fromConfig === "number" &&
    Number.isFinite(fromConfig) &&
    fromConfig >= 0
  ) {
    return Math.trunc(fromConfig);
  }
  return 0;
}

export function createSlackAdapter(
  config: SlackChannelAccount,
): ChannelAdapter {
  let app: SlackApp | null = null;
  let writeClient: SlackWriteClient | null = null;
  let running = false;
  let botUserId: string | null = null;
  let botTeamId: string | null = null;
  const knownThreadIdsByMessageId = new Map<string, string | null>();
  const knownUserDisplayNames = new Map<string, string>();
  const seenIngressMessageKeys = new Map<string, number>();
  // Tracks threads the agent has sent messages to so that inbound replies in
  // those threads are auto-routed without requiring an explicit @mention.
  const agentThreadTracker = createAgentThreadTracker();
  const progressCardByReplyKey = new Map<string, SlackProgressCardEntry>();
  const activeProgressCardKeyByReplyKey = new Map<string, string>();
  // Live Slack-side streams whose stop failed transiently (rate limit,
  // network blip — anything but the dead-stream case): the local entry gets
  // reset for the next turn, but Slack keeps rendering the old spinner.
  // Recorded per replyKey (stream ts → intended terminal plan title) and
  // swept before the next startStream in the same thread, so at most one
  // live progress stream exists per thread (LET-9515).
  const orphanedStreamsByReplyKey = new Map<string, Map<string, string>>();
  const assistantStatusReplyKeys = new Set<string>();
  const assistantStatusTextByReplyKey = new Map<string, string>();
  const progressUpdateThrottleMs = resolveSlackProgressUpdateThrottleMs();
  const progressStreamKeepaliveMs = resolveSlackProgressStreamKeepaliveMs();
  const statusStreamRollMs = resolveSlackStatusStreamRollMs();
  const completionFinalizeGraceMs = resolveSlackCompletionFinalizeGraceMs();
  // Per-account progress rendering style. "rich" (default) uses streamed
  // progress cards; "text" posts one plain status message per turn and edits
  // it in place. "rich" degrades to "text" when the Slack client/workspace
  // does not expose chat.startStream.
  const configuredProgressUi: SlackProgressUiMode =
    config.progressUi === "text" ? "text" : "rich";

  // ── Inbound debounce (optional) ───────────────────────────────
  // When `inboundDebounceMs > 0`, short back-to-back messages from the same
  // sender in the same chat/thread stack into a single combined dispatch.
  const debounceMs = resolveSlackInboundDebounceMs(config);
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionDispatchedKeys = new Map<string, number>();

  function pruneAppMentionMaps(now: number): void {
    for (const [k, exp] of appMentionRetryKeys) {
      if (exp <= now) appMentionRetryKeys.delete(k);
    }
    for (const [k, exp] of appMentionDispatchedKeys) {
      if (exp <= now) appMentionDispatchedKeys.delete(k);
    }
  }

  function rememberAppMentionRetry(seenKey: string): void {
    const now = Date.now();
    pruneAppMentionMaps(now);
    appMentionRetryKeys.set(seenKey, now + APP_MENTION_RETRY_TTL_MS);
  }

  function consumeAppMentionRetry(seenKey: string): boolean {
    const now = Date.now();
    pruneAppMentionMaps(now);
    if (!appMentionRetryKeys.has(seenKey)) return false;
    appMentionRetryKeys.delete(seenKey);
    return true;
  }

  type SlackDebounceEntry = {
    inbound: InboundChannelMessage;
    raw: SlackDebounceRawInput;
    opts: { source: SlackDebounceSource; wasMentioned: boolean };
  };

  function getSlackDebounceEntryMessageKey(
    entry: SlackDebounceEntry,
  ): string | null {
    const messageId = entry.inbound.messageId;
    if (!isNonEmptyString(messageId)) {
      return null;
    }
    return `${entry.inbound.chatId}:${messageId}`;
  }

  function preferDuplicateSlackDebounceEntry(
    current: SlackDebounceEntry,
    candidate: SlackDebounceEntry,
  ): SlackDebounceEntry {
    if (current.opts.source === "app_mention") {
      return current;
    }
    if (candidate.opts.source === "app_mention") {
      return candidate;
    }
    if (current.inbound.isMention === true) {
      return current;
    }
    if (candidate.inbound.isMention === true) {
      return candidate;
    }
    return candidate;
  }

  function dedupeSlackDebounceEntries(
    entries: SlackDebounceEntry[],
  ): SlackDebounceEntry[] {
    const indexByMessageKey = new Map<string, number>();
    const deduped: SlackDebounceEntry[] = [];
    for (const entry of entries) {
      const messageKey = getSlackDebounceEntryMessageKey(entry);
      if (!messageKey) {
        deduped.push(entry);
        continue;
      }
      const existingIndex = indexByMessageKey.get(messageKey);
      if (existingIndex === undefined) {
        indexByMessageKey.set(messageKey, deduped.length);
        deduped.push(entry);
        continue;
      }
      const existing = deduped[existingIndex];
      if (existing) {
        deduped[existingIndex] = preferDuplicateSlackDebounceEntry(
          existing,
          entry,
        );
      }
    }
    return deduped;
  }

  const debouncer: InboundDebouncer<SlackDebounceEntry> =
    createInboundDebouncer<SlackDebounceEntry>({
      debounceMs,
      buildKey: ({ raw }) => buildSlackDebounceKey(raw, config.accountId),
      shouldDebounce: ({ inbound }) =>
        !inbound.attachments?.length && !inbound.reaction,
      onFlush: async (entries) => {
        const dedupedEntries = dedupeSlackDebounceEntries(entries);
        const last = dedupedEntries[dedupedEntries.length - 1];
        if (!last) return;

        // Prune the flushed debounce key from the top-level conversation map.
        const flushedKey = buildSlackDebounceKey(last.raw, config.accountId);
        const conversationKey = buildTopLevelSlackConversationKey(
          last.raw,
          config.accountId,
        );
        if (flushedKey && conversationKey) {
          const pending = pendingTopLevelDebounceKeys.get(conversationKey);
          if (pending) {
            pending.delete(flushedKey);
            if (pending.size === 0) {
              pendingTopLevelDebounceKeys.delete(conversationKey);
            }
          }
        }

        // Resolve the message-vs-app_mention race for the last entry's ts.
        if (isNonEmptyString(last.inbound.messageId)) {
          const seenKey = `${last.inbound.chatId}:${last.inbound.messageId}`;
          pruneAppMentionMaps(Date.now());
          if (last.opts.source === "app_mention") {
            appMentionDispatchedKeys.set(
              seenKey,
              Date.now() + APP_MENTION_RETRY_TTL_MS,
            );
          } else if (
            last.opts.source === "message" &&
            appMentionDispatchedKeys.has(seenKey)
          ) {
            // An app_mention already dispatched for this ts; drop the
            // redundant message event to avoid double dispatch.
            appMentionDispatchedKeys.delete(seenKey);
            appMentionRetryKeys.delete(seenKey);
            return;
          }
          appMentionRetryKeys.delete(seenKey);
        }

        // Merge buffered entries into a single dispatch.
        const combinedText =
          dedupedEntries.length === 1
            ? last.inbound.text
            : dedupedEntries
                .map((entry) => entry.inbound.text)
                .filter((text) => text && text.length > 0)
                .join("\n");
        const combinedMentioned = dedupedEntries.some(
          (entry) =>
            entry.opts.wasMentioned === true ||
            entry.inbound.isMention === true,
        );
        const merged: InboundChannelMessage = {
          ...last.inbound,
          text: combinedText,
          isMention: combinedMentioned,
        };

        if (!adapter.onMessage) return;
        try {
          await adapter.onMessage(merged);
        } catch (error) {
          console.error(
            "[Slack] Error handling debounced inbound message:",
            error,
          );
        }
      },
      onError: (err) => {
        console.error(
          "[Slack] Inbound debounce flush failed:",
          err instanceof Error ? err.message : err,
        );
      },
    });

  async function dispatchInboundThroughDebouncer(
    entry: SlackDebounceEntry,
  ): Promise<void> {
    const { raw, inbound } = entry;
    const debounceKey = buildSlackDebounceKey(raw, config.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(
      raw,
      config.accountId,
    );
    const canDebounce =
      debounceMs > 0 &&
      !inbound.attachments?.length &&
      !inbound.reaction &&
      Boolean(debounceKey);

    // Non-debounceable message: first flush any pending debounced buffers for
    // the same (channel, sender) so ordering is preserved.
    if (!canDebounce && conversationKey) {
      const pending = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pending && pending.size > 0) {
        for (const pendingKey of Array.from(pending)) {
          try {
            await debouncer.flushKey(pendingKey);
          } catch {}
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pending =
        pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pending.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pending);
    }
    await debouncer.enqueue(entry);
  }

  function buildIngressMessageKey(
    channelId: string | undefined,
    messageId: string | undefined,
  ): string | null {
    if (!isNonEmptyString(channelId) || !isNonEmptyString(messageId)) {
      return null;
    }
    return `${channelId}:${messageId}`;
  }

  function pruneSeenIngressMessageKeys(now: number = Date.now()): void {
    for (const [key, expiresAt] of seenIngressMessageKeys) {
      if (expiresAt <= now) {
        seenIngressMessageKeys.delete(key);
      }
    }

    if (seenIngressMessageKeys.size <= SLACK_INGRESS_DEDUPE_MAX) {
      return;
    }

    const oldestEntries = Array.from(seenIngressMessageKeys.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    const overflowCount =
      seenIngressMessageKeys.size - SLACK_INGRESS_DEDUPE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        seenIngressMessageKeys.delete(entry[0]);
      }
    }
  }

  function getLifecycleReplyKey(source: ChannelTurnSource): string | null {
    if (source.channel !== "slack" || !isNonEmptyString(source.chatId)) {
      return null;
    }
    const replyToMessageId = resolveSlackProgressThreadTs(source);
    if (!isNonEmptyString(replyToMessageId)) {
      return null;
    }
    return `${source.chatId}:${replyToMessageId}`;
  }

  function getLifecycleErrorReplyKey(source: ChannelTurnSource): string | null {
    if (source.channel !== "slack" || !isNonEmptyString(source.chatId)) {
      return null;
    }
    if (
      source.chatType === "direct" ||
      resolveSlackChatType(source.chatId) === "direct"
    ) {
      const replyToMessageId = resolveSlackSourceThreadTs(source);
      return isNonEmptyString(replyToMessageId)
        ? `${source.chatId}:${replyToMessageId}`
        : `${source.chatId}:direct`;
    }
    return getLifecycleReplyKey(source);
  }

  function formatSlackLifecycleErrorMessage(
    errorText: string,
    runId?: string | null,
  ): string {
    return formatChannelLifecycleErrorMessage(errorText, {
      codeBlock: true,
      maxLength: SLACK_LIFECYCLE_ERROR_TEXT_MAX,
      runId,
    });
  }

  async function sendLifecycleErrorReply(
    source: ChannelTurnSource,
    errorText: string,
    runId?: string | null,
  ): Promise<void> {
    const replyToMessageId = resolveSlackSourceThreadTs(source);

    await ensureApp();
    const slackClient = await ensureWriteClient();
    const response = await slackClient.chat.postMessage({
      channel: source.chatId,
      text: formatSlackLifecycleErrorMessage(errorText, runId),
      ...(replyToMessageId ? { thread_ts: replyToMessageId } : {}),
    });
    rememberMessageThread(response.ts, replyToMessageId ?? null);
  }

  function buildSlackProgressCardKey(
    source: ChannelTurnSource,
    slotId?: string,
  ): string | null {
    const replyKey = getLifecycleReplyKey(source);
    if (!replyKey) {
      return null;
    }
    const turnId = firstNonEmptyString(
      slotId,
      source.messageId,
      source.threadId,
    );
    return turnId ? `${replyKey}:slot:${turnId}` : replyKey;
  }

  function getActiveSlackProgressCardKey(
    source: ChannelTurnSource,
  ): string | null {
    const replyKey = getLifecycleReplyKey(source);
    if (!replyKey) {
      return null;
    }
    return activeProgressCardKeyByReplyKey.get(replyKey) ?? null;
  }

  function getOrCreateSlackProgressCardKey(
    source: ChannelTurnSource,
    slotId?: string,
  ): string | null {
    return (
      getActiveSlackProgressCardKey(source) ??
      buildSlackProgressCardKey(source, slotId)
    );
  }

  function getSlackProgressReplyTs(source: ChannelTurnSource): string | null {
    const replyToMessageId = resolveSlackProgressThreadTs(source);
    return isNonEmptyString(replyToMessageId) ? replyToMessageId : null;
  }

  function getUniqueSlackProgressSources(
    sources: ChannelTurnSource[],
  ): ChannelTurnSource[] {
    const seen = new Set<string>();
    const unique: ChannelTurnSource[] = [];
    for (const source of sources) {
      const key = getOrCreateSlackProgressCardKey(source);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(source);
    }
    return unique;
  }

  function getSlackAssistantThreadStatusForTurn(
    source: ChannelTurnSource,
  ): string | null {
    const key = getLifecycleReplyKey(source);
    if (!key) {
      return null;
    }
    const existing = assistantStatusTextByReplyKey.get(key);
    if (existing) {
      return existing;
    }
    const status = getRandomSlackAssistantStatusVerb();
    assistantStatusTextByReplyKey.set(key, status);
    return status;
  }

  function isSlackProgressCardRendering(source: ChannelTurnSource): boolean {
    const activeKey = getActiveSlackProgressCardKey(source);
    const entry = activeKey ? progressCardByReplyKey.get(activeKey) : undefined;
    return Boolean(
      entry &&
        (entry.mode === "stream" ||
          (entry.pendingStreamChunks?.length ?? 0) > 0 ||
          entry.pendingFlush),
    );
  }

  async function setSlackAssistantThreadStatus(
    source: ChannelTurnSource,
    status: string,
  ): Promise<void> {
    const key = getLifecycleReplyKey(source);
    const threadTs = getSlackProgressReplyTs(source);
    if (!key || !threadTs) {
      return;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    const assistantThreads = slackClient.assistant?.threads;
    if (!assistantThreads?.setStatus) {
      return;
    }
    try {
      await assistantThreads.setStatus({
        channel_id: source.chatId,
        thread_ts: threadTs,
        status,
        ...(status ? { loading_messages: [status] } : {}),
      });
      if (status) {
        assistantStatusReplyKeys.add(key);
        assistantStatusTextByReplyKey.set(key, status);
      } else {
        assistantStatusReplyKeys.delete(key);
        assistantStatusTextByReplyKey.delete(key);
      }
    } catch (error) {
      console.warn(
        "[Slack] Failed to update assistant thread status:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function clearSlackAssistantThreadStatus(
    source: ChannelTurnSource,
  ): Promise<void> {
    const key = getLifecycleReplyKey(source);
    if (!key || !assistantStatusReplyKeys.has(key)) {
      return;
    }
    await setSlackAssistantThreadStatus(source, "");
  }

  function canStartSlackStream(source: ChannelTurnSource): boolean {
    if (source.chatType === "direct") {
      return isNonEmptyString(getSlackProgressReplyTs(source));
    }
    if (source.chatType !== "channel") {
      return true;
    }
    return (
      isNonEmptyString(source.senderId) &&
      isNonEmptyString(source.senderTeamId ?? botTeamId)
    );
  }

  function buildSlackStartStreamArgs(
    entry: SlackProgressCardEntry,
    replyToMessageId: string,
    rawChunks: SlackStreamChunk[],
  ): SlackStartStreamArgs {
    const initialChunks = compactSlackStreamChunks(rawChunks, entry);
    const args: SlackStartStreamArgs = {
      channel: entry.source.chatId,
      thread_ts: replyToMessageId,
      task_display_mode: "plan",
      chunks: initialChunks,
    };
    const recipientTeamId = entry.source.senderTeamId ?? botTeamId;
    if (
      entry.source.chatType === "channel" &&
      isNonEmptyString(entry.source.senderId) &&
      isNonEmptyString(recipientTeamId)
    ) {
      args.recipient_user_id = entry.source.senderId;
      args.recipient_team_id = recipientTeamId;
    }
    return args;
  }

  function rememberOrphanedSlackProgressStream(
    source: ChannelTurnSource,
    streamTs: string,
    terminalPlanTitle: string,
  ): void {
    const replyKey = getLifecycleReplyKey(source);
    if (!replyKey) {
      return;
    }
    let orphans = orphanedStreamsByReplyKey.get(replyKey);
    if (!orphans) {
      if (orphanedStreamsByReplyKey.size >= SLACK_ORPHANED_STREAM_THREADS_MAX) {
        const oldestKey = orphanedStreamsByReplyKey.keys().next().value;
        if (oldestKey !== undefined) {
          orphanedStreamsByReplyKey.delete(oldestKey);
        }
      }
      orphans = new Map();
      orphanedStreamsByReplyKey.set(replyKey, orphans);
    }
    if (orphans.size >= SLACK_ORPHANED_STREAMS_PER_THREAD_MAX) {
      return;
    }
    orphans.set(streamTs, terminalPlanTitle);
    console.warn(
      "[Slack] Progress stream stop failed; deferring close until the next stream in this thread:",
      streamTs,
    );
  }

  /**
   * Close any live streams a previous turn failed to stop in this thread
   * before starting a new one, so two spinners never render side by side
   * (LET-9515). Each orphan gets one close attempt: a stream that already
   * left streaming state (finalized or expired) is terminal either way, so
   * `message_not_in_streaming_state` is treated as success and anything else
   * is logged and dropped rather than retried forever.
   */
  async function sweepOrphanedSlackProgressStreams(
    source: ChannelTurnSource,
    slackClient: SlackWriteClient,
  ): Promise<void> {
    const replyKey = getLifecycleReplyKey(source);
    if (!replyKey) {
      return;
    }
    const orphans = orphanedStreamsByReplyKey.get(replyKey);
    if (!orphans || orphans.size === 0) {
      return;
    }
    orphanedStreamsByReplyKey.delete(replyKey);
    const stopStream = slackClient.chat.stopStream;
    if (!stopStream) {
      return;
    }
    for (const [ts, terminalPlanTitle] of orphans) {
      try {
        const response = await stopStream.call(slackClient.chat, {
          channel: source.chatId,
          ts,
          chunks: [{ type: "plan_update", title: terminalPlanTitle }],
        });
        if (
          response.ok === false &&
          !isSlackMessageNotStreamingStateError(response.error)
        ) {
          console.warn(
            "[Slack] Failed to stop orphaned progress stream:",
            response.error ?? "unknown error",
          );
        }
      } catch (error) {
        if (!isSlackMessageNotStreamingStateError(error)) {
          console.warn(
            "[Slack] Failed to stop orphaned progress stream:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }

  async function startSlackProgressStream(
    entry: SlackProgressCardEntry,
    replyToMessageId: string,
    rawChunks: SlackStreamChunk[],
  ): Promise<boolean> {
    if (!canStartSlackStream(entry.source)) {
      return false;
    }
    if (rawChunks.length === 0) {
      return true;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    const startStream = slackClient.chat.startStream;
    if (!startStream) {
      return false;
    }
    await sweepOrphanedSlackProgressStreams(entry.source, slackClient);
    try {
      const args = buildSlackStartStreamArgs(
        entry,
        replyToMessageId,
        rawChunks,
      );
      const response = await startStream.call(slackClient.chat, args);
      if (response.ok === false || !isNonEmptyString(response.ts)) {
        console.warn(
          "[Slack] Failed to start progress stream:",
          response.error ?? "missing stream ts",
        );
        return false;
      }
      entry.mode = "stream";
      entry.streamTs = response.ts;
      entry.streamDead = undefined;
      rememberMessageThread(response.ts, replyToMessageId);
      rememberSlackStreamTaskDetails(entry, args.chunks ?? []);
      // Once the native stream card is visible, clear Slack's assistant
      // thread status so Slack doesn't render a second "is processing" field
      // under our task card.
      await clearSlackAssistantThreadStatus(entry.source);
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to start progress stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  function markSlackProgressStreamDead(
    entry: SlackProgressCardEntry,
    reason: string,
  ): void {
    if (entry.streamDead) {
      return;
    }
    entry.streamDead = true;
    clearSlackProgressStreamTimers(entry);
    console.warn(
      "[Slack] Progress stream left streaming state unexpectedly:",
      reason,
    );
    trackBoundaryError({
      context: "slack progress stream",
      errorType: "slack_progress_stream_dead",
      error: reason,
    });
  }

  /**
   * Replace a dead stream's message content with the terminal card state via
   * chat.update. Slack refuses stream calls once a message leaves streaming
   * state, so this is the only way the final retitle/error details can still
   * reach the thread instead of leaving a stuck red spinner row.
   */
  async function rewriteDeadSlackProgressStream(
    entry: SlackProgressCardEntry,
    chunks: SlackStreamChunk[],
  ): Promise<boolean> {
    if (!entry.streamTs) {
      return false;
    }
    try {
      const slackClient = await ensureWriteClient();
      const { text, blocks } = buildSlackDeadStreamRewrite(entry, chunks);
      await slackClient.chat.update({
        channel: entry.source.chatId,
        ts: entry.streamTs,
        text,
        blocks,
      });
      rememberSlackStreamTaskDetails(entry, chunks);
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to rewrite dead progress stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async function appendSlackProgressStream(
    entry: SlackProgressCardEntry,
    rawChunks: SlackStreamChunk[],
  ): Promise<boolean> {
    if (!entry.streamTs) {
      return true;
    }
    if (entry.streamDead) {
      // Chunks requeue via the flush path and reach the thread through the
      // terminal dead-stream rewrite instead.
      return false;
    }
    const chunks = compactSlackStreamChunks(rawChunks, entry);
    if (chunks.length === 0) {
      return true;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    const appendStream = slackClient.chat.appendStream;
    if (!appendStream) {
      return false;
    }
    try {
      const response = await appendStream.call(slackClient.chat, {
        channel: entry.source.chatId,
        ts: entry.streamTs,
        chunks,
      });
      if (response.ok === false) {
        if (isSlackMessageNotStreamingStateError(response.error)) {
          markSlackProgressStreamDead(entry, "append_not_in_streaming_state");
        }
        console.warn(
          "[Slack] Failed to append progress stream:",
          response.error ?? "unknown error",
        );
        return false;
      }
      rememberSlackStreamTaskDetails(entry, chunks);
      return true;
    } catch (error) {
      if (isSlackMessageNotStreamingStateError(error)) {
        markSlackProgressStreamDead(entry, "append_not_in_streaming_state");
      }
      console.warn(
        "[Slack] Failed to append progress stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async function stopSlackProgressStream(
    entry: SlackProgressCardEntry,
    finalErrorChunk?: SlackStreamChunk,
  ): Promise<boolean> {
    if (!entry.streamTs) {
      return true;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    const stopStream = slackClient.chat.stopStream;
    if (!stopStream) {
      return false;
    }
    // Only a genuinely failed turn closes remaining rows with the red error
    // status. Cancelled turns are user stops, not failures — their rows close
    // as "Stopped" with a neutral complete status so an interrupted turn is
    // visually distinguishable from a crashed one.
    const terminalTaskStatus: SlackStreamTaskStatus =
      entry.status === "error" ? "error" : "complete";
    const chunks = buildTerminalSlackStreamChunks(
      entry,
      terminalTaskStatus,
      finalErrorChunk,
    );
    if (entry.streamDead) {
      return await rewriteDeadSlackProgressStream(entry, chunks);
    }
    try {
      const args: SlackStopStreamArgs = {
        channel: entry.source.chatId,
        ts: entry.streamTs,
      };
      // No footnote on the terminal stop: markdown_text cannot be combined
      // with chunks (the API rejects the pair; it silently broke every
      // terminal stop until #3275), and delivering it as a markdown_text
      // CHUNK renders as loud full-size body text under the card. The web
      // deep link rides as a small context block on outbound replies
      // instead, and on the block-rendered terminal paths
      // (text progress mode, dead-stream rewrite).
      if (chunks.length > 0) {
        args.chunks = chunks;
      }
      const response = await stopStream.call(slackClient.chat, args);
      if (response.ok === false) {
        if (isSlackMessageNotStreamingStateError(response.error)) {
          markSlackProgressStreamDead(entry, "stop_not_in_streaming_state");
          return await rewriteDeadSlackProgressStream(entry, chunks);
        }
        console.warn(
          "[Slack] Failed to stop progress stream:",
          response.error ?? "unknown error",
        );
        return false;
      }
      rememberSlackStreamTaskDetails(entry, chunks);
      return true;
    } catch (error) {
      if (isSlackMessageNotStreamingStateError(error)) {
        markSlackProgressStreamDead(entry, "stop_not_in_streaming_state");
        return await rewriteDeadSlackProgressStream(entry, chunks);
      }
      console.warn(
        "[Slack] Failed to stop progress stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  function scheduleProgressCardFlush(
    key: string,
    entry: SlackProgressCardEntry,
    delayMs: number,
  ): void {
    if (entry.pendingTimer) {
      return;
    }
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = undefined;
      void flushSlackProgressCard(key, entry);
    }, delayMs);
    const timer = entry.pendingTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  function clearSlackProgressStreamKeepalive(
    entry: SlackProgressCardEntry,
  ): void {
    if (entry.keepaliveTimer) {
      clearTimeout(entry.keepaliveTimer);
      entry.keepaliveTimer = undefined;
    }
  }

  function clearSlackStatusStreamRoll(entry: SlackProgressCardEntry): void {
    if (entry.streamRollTimer) {
      clearTimeout(entry.streamRollTimer);
      entry.streamRollTimer = undefined;
    }
  }

  /** Turn-scoped teardown: keepalive AND the status-stream roll timer. */
  function clearSlackProgressStreamTimers(entry: SlackProgressCardEntry): void {
    clearSlackProgressStreamKeepalive(entry);
    clearSlackStatusStreamRoll(entry);
  }

  /**
   * Proactively roll a simple-view status stream before Slack's hard stream
   * lifetime cap (~5 minutes, measured live 2026-07-08 — append activity does
   * not extend it). A fresh stream re-renders the same dim title below, and
   * the old message is deleted (an expired plan-only stream is an empty
   * message, so even a failed delete leaves no visible artifact). This is how
   * the placeholder survives arbitrarily long turns without ever freezing.
   */
  function scheduleSlackStatusStreamRoll(
    key: string,
    entry: SlackProgressCardEntry,
  ): void {
    if (
      statusStreamRollMs <= 0 ||
      entry.streamRollTimer ||
      entry.status !== "processing" ||
      entry.mode !== "status-stream" ||
      entry.streamDead ||
      !entry.streamTs
    ) {
      return;
    }
    entry.streamRollTimer = setTimeout(() => {
      entry.streamRollTimer = undefined;
      void (async () => {
        if (
          progressCardByReplyKey.get(key) !== entry ||
          entry.status !== "processing" ||
          entry.mode !== "status-stream" ||
          entry.streamDead ||
          !entry.streamTs
        ) {
          return;
        }
        const replyToMessageId = getSlackProgressReplyTs(entry.source);
        if (!replyToMessageId) {
          return;
        }
        const oldTs = entry.streamTs;
        // Re-arm first, then delete the old placeholder: the swap reads as
        // one continuous status line.
        entry.mode = undefined;
        entry.streamTs = undefined;
        entry.lastPlanTitle = undefined;
        const didStart = await startSlackStatusStream(entry, replyToMessageId);
        if (!didStart) {
          // Keep the old stream: it stays live until the cap, and death
          // detection (keepalive/flush) degrades it to text edits.
          entry.mode = "status-stream";
          entry.streamTs = oldTs;
          return;
        }
        try {
          const slackClient = await ensureWriteClient();
          await slackClient.chat.delete?.({
            channel: entry.source.chatId,
            ts: oldTs,
          });
        } catch {
          // Best-effort: an abandoned plan-only stream expires to an empty
          // message with no error artifact.
        }
        scheduleSlackStatusStreamRoll(key, entry);
        resetSlackProgressStreamKeepalive(key, entry);
      })().catch((error) => {
        console.warn(
          "[Slack] Failed to roll status stream:",
          error instanceof Error ? error.message : error,
        );
      });
    }, statusStreamRollMs);
  }

  function clearSlackCompletionFinalizer(entry: SlackProgressCardEntry): void {
    if (entry.completedFinalizerTimer) {
      clearTimeout(entry.completedFinalizerTimer);
      entry.completedFinalizerTimer = undefined;
    }
  }

  function scheduleSlackCompletionFinalizer(
    key: string,
    entry: SlackProgressCardEntry,
    batchId?: string,
  ): void {
    clearSlackCompletionFinalizer(entry);
    if (completionFinalizeGraceMs <= 0) {
      void finishSlackProgressCards([entry.source], "completed", batchId);
      return;
    }
    entry.completedFinalizerTimer = setTimeout(() => {
      entry.completedFinalizerTimer = undefined;
      void (async () => {
        if (progressCardByReplyKey.get(key) !== entry) {
          return;
        }
        await finishSlackProgressCards([entry.source], "completed", batchId);
      })().catch((error) => {
        console.warn(
          "[Slack] Failed to finalize completed progress stream:",
          error instanceof Error ? error.message : error,
        );
      });
    }, completionFinalizeGraceMs);
    const timer = entry.completedFinalizerTimer as ReturnType<
      typeof setTimeout
    > & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  function scheduleSlackProgressStreamKeepalive(
    key: string,
    entry: SlackProgressCardEntry,
  ): void {
    if (
      progressStreamKeepaliveMs <= 0 ||
      entry.keepaliveTimer ||
      entry.status !== "processing" ||
      (entry.mode !== "stream" && entry.mode !== "status-stream") ||
      entry.streamDead ||
      !entry.streamTs
    ) {
      return;
    }

    entry.keepaliveTimer = setTimeout(() => {
      entry.keepaliveTimer = undefined;
      void (async () => {
        if (
          progressCardByReplyKey.get(key) !== entry ||
          entry.status !== "processing" ||
          (entry.mode !== "stream" && entry.mode !== "status-stream") ||
          !entry.streamTs
        ) {
          return;
        }
        // Status streams keep their current title on keepalive appends so the
        // refresh causes no visible change.
        const keepaliveChunk: SlackStreamChunk =
          entry.mode === "status-stream"
            ? {
                type: "plan_update",
                title:
                  entry.lastPlanTitle ?? formatSlackStatusStreamTitle(entry),
              }
            : buildSlackPlanUpdateChunk(entry);
        const didAppend = await appendSlackProgressStream(entry, [
          keepaliveChunk,
        ]);
        if (!didAppend) {
          // A transient append failure (rate limit, network blip) must not
          // permanently silence the keepalive: Slack expires idle streams and
          // an expired stream renders a stuck red warning row. Keep retrying
          // on the same cadence until the turn finishes or the stream is
          // confirmed dead — and once it is, degrade to the edited-message
          // transport immediately so a long-running silent tool does not
          // leave the red corpse on screen until the next progress event.
          if (!entry.streamDead) {
            scheduleSlackProgressStreamKeepalive(key, entry);
          } else {
            await degradeDeadSlackStreamToText(entry);
          }
          return;
        }
        entry.lastSentAt = Date.now();
        scheduleSlackProgressStreamKeepalive(key, entry);
      })().catch((error) => {
        console.warn(
          "[Slack] Failed to keep progress stream alive:",
          error instanceof Error ? error.message : error,
        );
      });
    }, progressStreamKeepaliveMs);
    const timer = entry.keepaliveTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  function resetSlackProgressStreamKeepalive(
    key: string,
    entry: SlackProgressCardEntry,
  ): void {
    clearSlackProgressStreamKeepalive(entry);
    scheduleSlackProgressStreamKeepalive(key, entry);
  }

  /**
   * Start a simple-view status stream: a native stream carrying a single
   * plan_update title. Renders as a shimmering agent name over a dim status
   * line — no task card chrome. The assistant thread status ("is working")
   * footer is deliberately kept alongside it, unlike the task-card stream.
   */
  async function startSlackStatusStream(
    entry: SlackProgressCardEntry,
    replyToMessageId: string,
  ): Promise<boolean> {
    if (!canStartSlackStream(entry.source)) {
      return false;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    const startStream = slackClient.chat.startStream;
    if (!startStream) {
      return false;
    }
    await sweepOrphanedSlackProgressStreams(entry.source, slackClient);
    try {
      const title = formatSlackStatusStreamTitle(entry);
      const args: SlackStartStreamArgs = {
        channel: entry.source.chatId,
        thread_ts: replyToMessageId,
        chunks: [{ type: "plan_update", title }],
      };
      const recipientTeamId = entry.source.senderTeamId ?? botTeamId;
      if (
        entry.source.chatType === "channel" &&
        isNonEmptyString(entry.source.senderId) &&
        isNonEmptyString(recipientTeamId)
      ) {
        args.recipient_user_id = entry.source.senderId;
        args.recipient_team_id = recipientTeamId;
      }
      const response = await startStream.call(slackClient.chat, args);
      if (response.ok === false || !isNonEmptyString(response.ts)) {
        console.warn(
          "[Slack] Failed to start status stream:",
          response.error ?? "missing stream ts",
        );
        return false;
      }
      entry.mode = "status-stream";
      entry.streamTs = response.ts;
      entry.streamDead = undefined;
      entry.lastPlanTitle = title;
      rememberMessageThread(response.ts, replyToMessageId);
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to start status stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Advance a simple-view status stream: live flushes swap the plan title;
   * terminal flushes stop the stream with the turn's activity summary (only
   * reached when no reply closed the stream first — the reply path stops the
   * stream with the reply text itself in sendMessage).
   */
  async function progressSlackStatusStream(
    entry: SlackProgressCardEntry,
  ): Promise<boolean> {
    if (!entry.streamTs) {
      return false;
    }
    const terminal = entry.status !== "processing";
    const slackClient = await ensureWriteClient();
    try {
      if (!terminal) {
        if (entry.streamDead) {
          // Nothing to update live; the terminal flush rewrites the message.
          return true;
        }
        const title = formatSlackStatusStreamTitle(entry);
        if (title === entry.lastPlanTitle) {
          return true;
        }
        const appendStream = slackClient.chat.appendStream;
        if (!appendStream) {
          return false;
        }
        const response = await appendStream.call(slackClient.chat, {
          channel: entry.source.chatId,
          ts: entry.streamTs,
          chunks: [{ type: "plan_update", title }],
        });
        if (response.ok === false) {
          if (isSlackMessageNotStreamingStateError(response.error)) {
            markSlackProgressStreamDead(
              entry,
              "status_append_not_in_streaming_state",
            );
          }
          return false;
        }
        entry.lastPlanTitle = title;
        return true;
      }
      const title = formatSlackTextProgressTerminalText(entry);
      if (entry.streamDead) {
        return await rewriteDeadSlackStatusStream(entry, title);
      }
      const stopStream = slackClient.chat.stopStream;
      if (!stopStream) {
        return false;
      }
      const response = await stopStream.call(slackClient.chat, {
        channel: entry.source.chatId,
        ts: entry.streamTs,
        chunks: [{ type: "plan_update", title }],
      });
      if (response.ok === false) {
        if (isSlackMessageNotStreamingStateError(response.error)) {
          markSlackProgressStreamDead(
            entry,
            "status_stop_not_in_streaming_state",
          );
          return await rewriteDeadSlackStatusStream(entry, title);
        }
        return false;
      }
      entry.lastPlanTitle = title;
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to update status stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Terminal fallback for a dead status stream: Slack refuses stream calls
   * once a message leaves streaming state, so rewrite it via chat.update into
   * the terminal summary line plus the web footnote.
   */
  async function rewriteDeadSlackStatusStream(
    entry: SlackProgressCardEntry,
    title: string,
  ): Promise<boolean> {
    if (!entry.streamTs) {
      return false;
    }
    try {
      const slackClient = await ensureWriteClient();
      const blocks: SlackBlock[] = [
        { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
      ];
      const footnote = buildSlackChatFootnote(entry.source);
      if (footnote) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: footnote }],
        });
      }
      await slackClient.chat.update({
        channel: entry.source.chatId,
        ts: entry.streamTs,
        text: title,
        blocks,
      });
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to rewrite dead status stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Take over a mid-turn dead stream as the plain-text live transport.
   *
   * Slack can force-stop a stream while the turn is still running (hard
   * stream lifetime, external stop). The corpse renders as a red warning row
   * that reads as an agent death even though the turn is healthy, and every
   * later update is silently skipped — minutes of zero on-surface liveness
   * (observed live 2026-07-08 on a 10-minute, 64-command turn). Rewrite the
   * dead message in place via chat.update and continue the turn on the
   * edited-message transport; the terminal edit then lands as usual.
   */
  async function degradeDeadSlackStreamToText(
    entry: SlackProgressCardEntry,
  ): Promise<boolean> {
    if (
      entry.status !== "processing" ||
      !entry.streamDead ||
      !isNonEmptyString(entry.streamTs) ||
      (entry.mode !== "stream" && entry.mode !== "status-stream")
    ) {
      return false;
    }
    const replyToMessageId = getSlackProgressReplyTs(entry.source);
    if (!replyToMessageId) {
      return false;
    }
    clearSlackProgressStreamTimers(entry);
    entry.textTs = entry.streamTs;
    entry.mode = "text";
    entry.streamTs = undefined;
    entry.streamDead = undefined;
    entry.lastPlanTitle = undefined;
    entry.pendingStreamChunks = [];
    entry.requeuedFailedChunks = false;
    // Force the text transport to actually edit the corpse.
    entry.lastSentText = undefined;
    return await upsertSlackTextProgressMessage(entry, replyToMessageId);
  }

  /**
   * Plain-text progress ("text" progress UI): one status message per turn,
   * posted on the first flush with visible activity and edited in place
   * afterwards. The terminal edit collapses to the turn's activity summary
   * (the rich card's terminal plan title) plus the chat footnote. Also the
   * automatic degradation target when chat.startStream is unavailable.
   */
  async function upsertSlackTextProgressMessage(
    entry: SlackProgressCardEntry,
    replyToMessageId: string,
  ): Promise<boolean> {
    const slackClient = await ensureWriteClient();
    const terminal = entry.status !== "processing";
    try {
      if (!entry.textTs) {
        if (terminal) {
          // Nothing was ever posted for this turn; a terminal-only status
          // message would be noise (the reply itself is the outcome).
          return true;
        }
        const response = await slackClient.chat.postMessage({
          channel: entry.source.chatId,
          text: formatSlackTextProgressLiveText(entry),
          thread_ts: replyToMessageId,
        });
        if (!isNonEmptyString(response.ts)) {
          return false;
        }
        entry.mode = "text";
        entry.textTs = response.ts;
        rememberMessageThread(response.ts, replyToMessageId);
        return true;
      }
      if (terminal) {
        const headerText = formatSlackTextProgressTerminalText(entry);
        const blocks: SlackBlock[] = [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${headerText}*` },
          },
        ];
        const footnote = buildSlackChatFootnote(entry.source);
        if (footnote) {
          blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: footnote }],
          });
        }
        await slackClient.chat.update({
          channel: entry.source.chatId,
          ts: entry.textTs,
          text: headerText,
          blocks,
        });
        return true;
      }
      await slackClient.chat.update({
        channel: entry.source.chatId,
        ts: entry.textTs,
        text: formatSlackTextProgressLiveText(entry),
      });
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to send text progress update:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async function flushSlackProgressCard(
    key: string,
    entry: SlackProgressCardEntry,
  ): Promise<void> {
    if (entry.pendingFlush) {
      await entry.pendingFlush;
      const latestText = formatSlackProgressCardText(
        entry.status,
        entry.latestText,
      );
      if (
        !entry.requeuedFailedChunks &&
        (entry.lastSentText !== latestText ||
          (entry.pendingStreamChunks?.length ?? 0) > 0)
      ) {
        await flushSlackProgressCard(key, entry);
      }
      return;
    }

    const operation = (async () => {
      entry.requeuedFailedChunks = false;
      const replyToMessageId = getSlackProgressReplyTs(entry.source);
      if (!replyToMessageId) {
        return;
      }
      const text = formatSlackProgressCardText(entry.status, entry.latestText);
      if (
        entry.lastSentText === text &&
        !entry.latestUpdate &&
        (entry.pendingStreamChunks?.length ?? 0) === 0
      ) {
        entry.lastSentAt = Date.now();
        return;
      }

      if (
        entry.status === "processing" &&
        !entry.mode &&
        (entry.pendingStreamChunks?.length ?? 0) === 0 &&
        configuredProgressUi !== "text"
      ) {
        entry.lastSentAt = Date.now();
        return;
      }

      const chunksToSend = [...(entry.pendingStreamChunks ?? [])];
      entry.pendingStreamChunks = [];
      let didSend = true;
      if (!entry.mode) {
        // Route the turn's first visible progress: the simple view (a native
        // status stream) by explicit config, the task-card stream otherwise.
        // Both degrade to the plain edited-message transport when the Slack
        // client/workspace does not expose chat.startStream.
        const slackClient = await ensureWriteClient();
        const canStream = typeof slackClient.chat.startStream === "function";
        if (configuredProgressUi === "text") {
          if (entry.status !== "processing") {
            // Turn already over with nothing on screen: the reply itself is
            // the outcome, a terminal-only status artifact would be noise.
            didSend = true;
          } else if (canStream) {
            didSend = await startSlackStatusStream(entry, replyToMessageId);
          } else {
            didSend = await upsertSlackTextProgressMessage(
              entry,
              replyToMessageId,
            );
          }
        } else if (!canStream) {
          didSend = await upsertSlackTextProgressMessage(
            entry,
            replyToMessageId,
          );
        } else {
          didSend = await startSlackProgressStream(
            entry,
            replyToMessageId,
            chunksToSend,
          );
        }
      } else if (entry.mode === "stream") {
        didSend = await appendSlackProgressStream(entry, chunksToSend);
      } else if (entry.mode === "status-stream") {
        didSend = await progressSlackStatusStream(entry);
      } else {
        didSend = await upsertSlackTextProgressMessage(entry, replyToMessageId);
      }

      if (!didSend && chunksToSend.length > 0) {
        entry.pendingStreamChunks = [
          ...chunksToSend,
          ...(entry.pendingStreamChunks ?? []),
        ];
        entry.requeuedFailedChunks = true;
      }

      if (!didSend && entry.streamDead && entry.status === "processing") {
        didSend = await degradeDeadSlackStreamToText(entry);
      }

      delete entry.latestUpdate;
      entry.lastSentText = text;
      entry.lastSentAt = Date.now();
      const isLiveStream =
        entry.mode === "stream" || entry.mode === "status-stream";
      if (didSend && isLiveStream && entry.status === "processing") {
        resetSlackProgressStreamKeepalive(key, entry);
        scheduleSlackStatusStreamRoll(key, entry);
      } else if (!isLiveStream || entry.status !== "processing") {
        clearSlackProgressStreamTimers(entry);
      }
    })()
      .catch((error) => {
        console.warn(
          "[Slack] Failed to update progress UI:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (progressCardByReplyKey.get(key) === entry) {
          entry.pendingFlush = undefined;
        }
      });

    entry.pendingFlush = operation;
    await operation;
    if (
      progressCardByReplyKey.get(key) === entry &&
      !entry.requeuedFailedChunks &&
      (entry.pendingStreamChunks?.length ?? 0) > 0
    ) {
      await flushSlackProgressCard(key, entry);
    }
  }

  function pruneSlackProgressCardState(now: number = Date.now()): void {
    for (const [key, entry] of progressCardByReplyKey) {
      if (
        !entry.pendingTimer &&
        !entry.pendingFlush &&
        !entry.completedFinalizerTimer &&
        entry.updatedAt + SLACK_PROGRESS_CARD_STATE_TTL_MS <= now
      ) {
        progressCardByReplyKey.delete(key);
        for (const [replyKey, activeKey] of activeProgressCardKeyByReplyKey) {
          if (activeKey === key) {
            activeProgressCardKeyByReplyKey.delete(replyKey);
          }
        }
      }
    }

    if (progressCardByReplyKey.size <= SLACK_PROGRESS_CARD_STATE_MAX) {
      return;
    }

    const oldestEntries = Array.from(progressCardByReplyKey.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const overflowCount =
      progressCardByReplyKey.size - SLACK_PROGRESS_CARD_STATE_MAX;
    let removed = 0;
    for (const [key, entry] of oldestEntries) {
      if (removed >= overflowCount) {
        break;
      }
      if (
        entry.pendingTimer ||
        entry.pendingFlush ||
        entry.completedFinalizerTimer
      ) {
        continue;
      }
      progressCardByReplyKey.delete(key);
      for (const [replyKey, activeKey] of activeProgressCardKeyByReplyKey) {
        if (activeKey === key) {
          activeProgressCardKeyByReplyKey.delete(replyKey);
        }
      }
      removed += 1;
    }
  }

  async function upsertSlackProgressCard(
    source: ChannelTurnSource,
    status: SlackProgressCardState,
    progressText: string,
    options: { force?: boolean; update?: ChannelTurnProgressEvent } = {},
  ): Promise<void> {
    const key = getOrCreateSlackProgressCardKey(
      source,
      options.update?.batchId,
    );
    if (!key) {
      return;
    }
    const now = Date.now();
    pruneSlackProgressCardState(now);
    const existingEntry = progressCardByReplyKey.get(key);
    if (options.update?.kind === "tool") {
      if (isSlackHiddenToolUpdate(existingEntry, options.update)) {
        if (
          !shouldShowSlackChannelResponseProgress(existingEntry, options.update)
        ) {
          return;
        }
      }
      if (!existingEntry && !options.update.toolName) {
        return;
      }
    }
    const entry =
      existingEntry ??
      ({
        source,
        status,
        latestText: progressText,
        lastSentAt: 0,
        updatedAt: now,
      } satisfies SlackProgressCardEntry);
    entry.source = source;
    entry.status = status;
    entry.latestText = progressText;
    entry.latestUpdate = options.update;
    clearSlackCompletionFinalizer(entry);
    rememberSlackToolName(entry, options.update);
    let streamChunks = options.update
      ? buildSlackStreamProgressChunks(entry, options.update)
      : [];
    if (!options.update && status === "processing") {
      const turnActiveChunks = reconcileSlackTurnActiveTask(entry);
      if (turnActiveChunks.length > 0) {
        streamChunks = [buildSlackPlanUpdateChunk(entry), ...turnActiveChunks];
      }
    }
    // For thinking/responding events, track header state without creating
    // stream chunks — we only want a streaming block when actual tools are
    // called. Still save the entry so an existing stream can update its plan
    // title, and the next tool update can clear the transient state.
    const isReasoningEvent =
      options.update?.kind === "thinking" ||
      options.update?.kind === "responding";
    if (options.update && streamChunks.length === 0 && !isReasoningEvent) {
      return;
    }
    if (streamChunks.length > 0) {
      entry.pendingStreamChunks ??= [];
      entry.pendingStreamChunks.push(...streamChunks);
    }
    entry.updatedAt = now;
    progressCardByReplyKey.set(key, entry);
    const replyKey = getLifecycleReplyKey(source);
    if (replyKey) {
      activeProgressCardKeyByReplyKey.set(replyKey, key);
    }

    // Reasoning-only updates with no stream chunks are status state only; they
    // must not start/throttle the Slack stream. Otherwise the first real tool
    // can be delayed by the reasoning timestamp and appear only once it has
    // already completed.
    if (isReasoningEvent && streamChunks.length === 0) {
      return;
    }

    const hasNewTaskDetails = streamChunks.some(
      (chunk) =>
        chunk.type === "task_update" &&
        isNonEmptyString(chunk.details) &&
        entry.sentTaskDetailsById?.get(chunk.id) !== chunk.details,
    );
    if ((options.force || hasNewTaskDetails) && entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = undefined;
    }
    const elapsed = now - entry.lastSentAt;
    if (
      options.force ||
      hasNewTaskDetails ||
      entry.lastSentAt === 0 ||
      progressUpdateThrottleMs === 0 ||
      elapsed >= progressUpdateThrottleMs
    ) {
      await flushSlackProgressCard(key, entry);
      return;
    }
    scheduleProgressCardFlush(
      key,
      entry,
      Math.max(0, progressUpdateThrottleMs - elapsed),
    );
  }

  async function finishSlackProgressCards(
    sources: ChannelTurnSource[],
    outcome: ChannelTurnOutcome,
    batchId?: string,
    errorText?: string | null,
    completionHeaderText?: string | null,
  ): Promise<void> {
    const progress = resolveSlackLifecycleProgressText(outcome);
    const finalErrorChunk =
      progress.status === "error"
        ? buildSlackLifecycleErrorTaskChunk(errorText)
        : undefined;
    const uniqueSources = getUniqueSlackProgressSources(sources);
    await Promise.all(
      uniqueSources.map(async (source) => {
        const key = getOrCreateSlackProgressCardKey(source, batchId);
        if (!key) {
          await clearSlackAssistantThreadStatus(source);
          return;
        }
        const entry = progressCardByReplyKey.get(key);
        if (!entry) {
          await clearSlackAssistantThreadStatus(source);
          return;
        }
        clearSlackProgressStreamTimers(entry);
        clearSlackCompletionFinalizer(entry);
        if (entry.pendingTimer) {
          clearTimeout(entry.pendingTimer);
          entry.pendingTimer = undefined;
        }
        entry.source = source;
        entry.status = progress.status;
        entry.latestText = progress.text;
        entry.completionHeaderText =
          progress.status === "completed"
            ? (completionHeaderText ?? undefined)
            : undefined;
        entry.errorText =
          progress.status === "error"
            ? (getChannelLifecycleErrorDisplay(errorText).body ??
              errorText ??
              undefined)
            : undefined;
        delete entry.latestUpdate;
        entry.updatedAt = Date.now();
        if (entry.mode === "stream") {
          const didStop = await stopSlackProgressStream(entry, finalErrorChunk);
          if (didStop) {
            entry.lastSentText = formatSlackProgressCardText(
              entry.status,
              entry.latestText,
            );
            entry.lastSentAt = Date.now();
          } else if (!entry.streamDead && entry.streamTs) {
            // The Slack-side stream is still live (spinning) but the entry
            // reset below wipes our record of it. Remember the orphan — with
            // the terminal plan title this stop was trying to render, so the
            // sweep replays the turn's real outcome instead of guessing — and
            // the next stream in this thread closes it first (LET-9515).
            // Dead streams are excluded: they already left streaming state,
            // so there is no spinner to close.
            rememberOrphanedSlackProgressStream(
              source,
              entry.streamTs,
              entry.status === "completed"
                ? formatSlackCompletionPlanTitle(entry)
                : entry.status === "cancelled"
                  ? "Interrupted"
                  : "Failed",
            );
          }
        } else {
          await upsertSlackProgressCard(
            source,
            progress.status,
            progress.text,
            {
              force: true,
            },
          );
        }
        // Reset the entry so the next turn starts fresh with a new
        // startStream call instead of trying to appendStream to a stopped
        // stream. Without this, subsequent turns don't create new tool
        // blocks in the Slack accordion.
        entry.mode = undefined;
        entry.streamTs = undefined;
        entry.streamDead = undefined;
        entry.textTs = undefined;
        entry.lastPlanTitle = undefined;
        entry.toolTasksById = undefined;
        entry.pendingStreamChunks = undefined;
        entry.toolNamesByCallId = undefined;
        entry.toolTitlesByCallId = undefined;
        entry.toolDetailsByCallId = undefined;
        entry.sentTaskDetailsById = undefined;
        entry.completionHeaderText = undefined;
        entry.reasoningActive = undefined;
        entry.placeholderTaskId = undefined;
        entry.placeholderTaskSequence = undefined;
        entry.toolTaskIdsByCallId = undefined;
        entry.hiddenToolCallIds = undefined;
        entry.completedFinalizerTimer = undefined;
        const replyKey = getLifecycleReplyKey(source);
        if (replyKey && activeProgressCardKeyByReplyKey.get(replyKey) === key) {
          activeProgressCardKeyByReplyKey.delete(replyKey);
        }
        await clearSlackAssistantThreadStatus(source);
      }),
    );
  }

  async function flushSlackProgressCardsForCompletedLifecycle(
    sources: ChannelTurnSource[],
    batchId?: string,
  ): Promise<void> {
    const uniqueSources = getUniqueSlackProgressSources(sources);
    await Promise.all(
      uniqueSources.map(async (source) => {
        const key = getOrCreateSlackProgressCardKey(source, batchId);
        if (!key) {
          await clearSlackAssistantThreadStatus(source);
          return;
        }
        const entry = progressCardByReplyKey.get(key);
        if (!entry) {
          await clearSlackAssistantThreadStatus(source);
          return;
        }
        clearSlackProgressStreamTimers(entry);
        if (entry.pendingTimer) {
          clearTimeout(entry.pendingTimer);
          entry.pendingTimer = undefined;
        }
        entry.source = source;
        entry.updatedAt = Date.now();
        await flushSlackProgressCard(key, entry);
        if (entry.mode) {
          scheduleSlackCompletionFinalizer(key, entry, batchId);
        }
        await clearSlackAssistantThreadStatus(source);
      }),
    );
  }

  function dropSlackProgressCardEntry(
    key: string,
    entry: SlackProgressCardEntry,
  ): void {
    clearSlackProgressStreamTimers(entry);
    clearSlackCompletionFinalizer(entry);
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = undefined;
    }
    if (progressCardByReplyKey.get(key) === entry) {
      progressCardByReplyKey.delete(key);
    }
    const replyKey = getLifecycleReplyKey(entry.source);
    if (replyKey && activeProgressCardKeyByReplyKey.get(replyKey) === key) {
      activeProgressCardKeyByReplyKey.delete(replyKey);
    }
  }

  /**
   * Simple view: fulfill an outbound reply by stopping the thread's live
   * status stream with the reply text — the shimmering placeholder becomes
   * the final message (one message per turn), with the web deep link attached
   * as a context block. Returns the message ts on success; undefined falls
   * back to a regular chat.postMessage.
   */
  async function maybeFulfillReplyViaStatusStream(
    msg: OutboundChannelMessage,
  ): Promise<string | undefined> {
    if (!isNonEmptyString(msg.text)) {
      return undefined;
    }
    const anchorTs = resolveSlackOutboundProgressThreadTs({
      threadId: msg.threadId,
      replyToMessageId: msg.replyToMessageId,
    });
    if (!isNonEmptyString(anchorTs)) {
      return undefined;
    }
    const rootTs = knownThreadIdsByMessageId.get(anchorTs) ?? anchorTs;
    const replyKey = `${msg.chatId}:${rootTs}`;
    const cardKey = activeProgressCardKeyByReplyKey.get(replyKey) ?? replyKey;
    const entry = progressCardByReplyKey.get(cardKey);
    if (!entry || entry.mode !== "status-stream") {
      return undefined;
    }
    if (entry.pendingFlush) {
      try {
        await entry.pendingFlush;
      } catch {
        // Flush failures are already logged; the stream state check below
        // decides whether the stop can still proceed.
      }
    }
    if (
      entry.mode !== "status-stream" ||
      !isNonEmptyString(entry.streamTs) ||
      entry.streamDead
    ) {
      return undefined;
    }
    const slackClient = await ensureWriteClient();
    const stopStream = slackClient.chat.stopStream;
    if (!stopStream) {
      return undefined;
    }
    const footnote =
      isNonEmptyString(msg.agentId) && isNonEmptyString(msg.conversationId)
        ? buildSlackChatFootnote({
            agentId: msg.agentId,
            conversationId: msg.conversationId,
          })
        : "";
    try {
      const response = await stopStream.call(slackClient.chat, {
        channel: entry.source.chatId,
        ts: entry.streamTs,
        chunks: [{ type: "markdown_text", text: msg.text }],
        ...(footnote
          ? {
              blocks: [
                {
                  type: "context",
                  elements: [{ type: "mrkdwn", text: footnote }],
                },
              ],
            }
          : {}),
      });
      if (response.ok === false) {
        if (isSlackMessageNotStreamingStateError(response.error)) {
          markSlackProgressStreamDead(
            entry,
            "reply_stop_not_in_streaming_state",
          );
        }
        return undefined;
      }
    } catch (error) {
      console.warn(
        "[Slack] Failed to deliver reply via status stream:",
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
    const ts = entry.streamTs;
    // The placeholder is now the reply. Drop the entry so the turn's finish
    // lifecycle does not try to close it a second time.
    dropSlackProgressCardEntry(cardKey, entry);
    await clearSlackAssistantThreadStatus(entry.source);
    return ts;
  }

  async function finishSlackProgressCardForOutboundMessage(
    msg: OutboundChannelMessage,
  ): Promise<void> {
    if (msg.channel !== "slack" || msg.reaction) {
      return;
    }
    const anchorTs = resolveSlackOutboundProgressThreadTs({
      threadId: msg.threadId,
      replyToMessageId: msg.replyToMessageId,
    });
    if (!isNonEmptyString(anchorTs)) {
      return;
    }
    // Canonicalize the anchor to its thread root before the card lookup.
    // Outbound replies can be anchored to a non-root message in the thread
    // (MessageChannel `replyTo` nulls threadId, and Slack happily threads a
    // reply-ts `thread_ts` under the parent), while progress cards are always
    // keyed by the thread root. Any bot message posted into a thread with a
    // live progress stream must invalidate that stream — the card closes out
    // above the reply and post-reply work reassembles as a fresh card below
    // (LET-9524).
    const rootTs = knownThreadIdsByMessageId.get(anchorTs) ?? anchorTs;
    const replyKey = `${msg.chatId}:${rootTs}`;
    const cardKey = activeProgressCardKeyByReplyKey.get(replyKey) ?? replyKey;
    const entry = progressCardByReplyKey.get(cardKey);
    if (!entry) {
      return;
    }

    try {
      await finishSlackProgressCards(
        [entry.source],
        "completed",
        undefined,
        undefined,
        msg.text,
      );
    } catch (error) {
      console.warn(
        "[Slack] Failed to finish progress card after outbound message:",
        error,
      );
    }
  }

  function markIngressMessageSeen(
    channelId: string | undefined,
    messageId: string | undefined,
  ): boolean {
    const key = buildIngressMessageKey(channelId, messageId);
    if (!key) {
      return false;
    }

    const now = Date.now();
    pruneSeenIngressMessageKeys(now);

    if (seenIngressMessageKeys.has(key)) {
      return true;
    }

    seenIngressMessageKeys.set(key, now + SLACK_INGRESS_DEDUPE_TTL_MS);
    return false;
  }

  function hasSlackMention(text: string, userId: string | null): boolean {
    if (!isNonEmptyString(text) || !isNonEmptyString(userId)) {
      return false;
    }

    return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
  }

  function rememberMessageThread(
    messageId: string | undefined,
    threadId: string | null,
  ): void {
    if (!isNonEmptyString(messageId)) {
      return;
    }
    knownThreadIdsByMessageId.set(messageId, threadId);
  }

  async function resolveUserName(
    slackApp: SlackApp,
    userId: string | undefined,
  ): Promise<string | undefined> {
    if (!isNonEmptyString(userId)) {
      return undefined;
    }

    const cached = knownUserDisplayNames.get(userId);
    if (cached) {
      return cached;
    }

    try {
      const userInfo = await slackApp.client.users.info({ user: userId });
      const displayName = resolveSlackUserDisplayName(userInfo);
      if (displayName) {
        knownUserDisplayNames.set(userId, displayName);
        return displayName;
      }
    } catch {}

    knownUserDisplayNames.set(userId, userId);
    return userId;
  }

  async function ensureApp(): Promise<SlackApp> {
    if (app) {
      return app;
    }

    const bolt = await loadSlackBoltModule();
    const App = resolveSlackAppConstructor(bolt);
    const instance = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    instance.error(async (error) => {
      console.error("[Slack] Unhandled app error:", error);
    });

    instance.message(async ({ message }) => {
      if (!adapter.onMessage) {
        return;
      }

      const rawMessage = asRecord(message);
      if (!rawMessage) {
        return;
      }

      const channelId = rawMessage.channel;
      if (!isNonEmptyString(channelId)) {
        return;
      }

      if (!isProcessableSlackInboundMessage(rawMessage)) {
        return;
      }

      const text = isNonEmptyString(rawMessage.text) ? rawMessage.text : "";
      const wasMentioned = hasSlackMention(text, botUserId);
      const attachments = await resolveSlackInboundAttachments({
        accountId: config.accountId,
        token: config.botToken,
        rawEvent: message,
        transcribeVoice: config.transcribeVoice === true,
      });
      const chatType = resolveSlackChatType(channelId);
      const threadId =
        chatType === "direct"
          ? (firstNonEmptyString(rawMessage.thread_ts) ?? null)
          : (firstNonEmptyString(rawMessage.thread_ts, rawMessage.ts) ?? null);
      rememberMessageThread(rawMessage.ts, threadId);
      const senderName = await resolveUserName(instance, rawMessage.user);

      // Auto-subscribe: if the user is replying in a thread the agent has
      // participated in, treat it as implicitly addressed (like a mention).
      const isAgentThread =
        chatType === "channel" &&
        isNonEmptyString(threadId) &&
        agentThreadTracker.has(channelId, threadId);
      const effectiveMention = wasMentioned || isAgentThread;

      if (chatType === "direct") {
        const seenKey = `${channelId}:${rawMessage.ts}`;
        const wasSeen = markIngressMessageSeen(channelId, rawMessage.ts);
        if (!wasSeen) {
          // Prime an app_mention retry allowance so a near-simultaneous
          // app_mention for the same ts is not dropped while this message
          // is in-flight through the debouncer.
          rememberAppMentionRetry(seenKey);
        } else {
          // Already dispatched — drop the duplicate. DMs can't fire an
          // app_mention event, so there's no retry-key case to honor here.
          return;
        }

        const inbound: InboundChannelMessage = {
          channel: "slack",
          accountId: config.accountId,
          chatId: channelId,
          senderId: rawMessage.user,
          senderTeamId: resolveSlackSenderTeamId(rawMessage),
          senderName,
          text: wasMentioned ? normalizeSlackText(text) : text,
          timestamp: slackTimestampToMillis(rawMessage.ts),
          messageId: rawMessage.ts,
          threadId,
          chatType: "direct",
          isMention: wasMentioned,
          attachments,
          raw: message,
        };

        try {
          await dispatchInboundThroughDebouncer({
            inbound,
            raw: rawMessage as SlackDebounceRawInput,
            opts: { source: "message", wasMentioned },
          });
        } catch (error) {
          console.error("[Slack] Error handling DM message:", error);
        }
        return;
      }

      if (!isNonEmptyString(rawMessage.thread_ts)) {
        return;
      }

      const seenKey = `${channelId}:${rawMessage.ts}`;
      const wasSeen = markIngressMessageSeen(channelId, rawMessage.ts);
      if (!wasSeen) {
        rememberAppMentionRetry(seenKey);
      } else {
        // Already seen. If an app_mention for the same ts arrives later it
        // will consume the retry key in its own handler; a duplicate
        // `message` event has nothing to redeem.
        return;
      }

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId: channelId,
        senderId: rawMessage.user,
        senderTeamId: resolveSlackSenderTeamId(rawMessage),
        senderName,
        chatLabel: channelId,
        text: wasMentioned ? normalizeSlackText(text) : text,
        timestamp: slackTimestampToMillis(rawMessage.ts),
        messageId: rawMessage.ts,
        threadId,
        chatType: "channel",
        isMention: effectiveMention,
        attachments,
        raw: message,
      };

      try {
        await dispatchInboundThroughDebouncer({
          inbound,
          raw: rawMessage as SlackDebounceRawInput,
          opts: { source: "message", wasMentioned: effectiveMention },
        });
      } catch (error) {
        console.error(
          "[Slack] Error handling threaded channel message:",
          error,
        );
      }
    });

    instance.event("app_mention", async ({ event }) => {
      if (!adapter.onMessage) {
        return;
      }

      if (
        !isNonEmptyString(event.channel) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.ts)
      ) {
        return;
      }

      const seenKey = `${event.channel}:${event.ts}`;
      const wasSeen = markIngressMessageSeen(event.channel, event.ts);
      if (wasSeen) {
        // A prior `message` event already claimed this ts. Allow the
        // app_mention through exactly once if a retry key was primed;
        // otherwise drop.
        if (!consumeAppMentionRetry(seenKey)) {
          return;
        }
      }

      rememberMessageThread(event.ts, event.thread_ts ?? event.ts);

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId: event.channel,
        senderId: event.user,
        senderTeamId: resolveSlackSenderTeamId(event),
        senderName: await resolveUserName(instance, event.user),
        chatLabel: event.channel,
        text: normalizeSlackText(event.text ?? ""),
        timestamp: slackTimestampToMillis(event.ts),
        messageId: event.ts,
        threadId: event.thread_ts ?? event.ts,
        chatType: "channel",
        isMention: true,
        attachments: await resolveSlackInboundAttachments({
          accountId: config.accountId,
          token: config.botToken,
          rawEvent: event,
          transcribeVoice: config.transcribeVoice === true,
        }),
        raw: event,
      };

      try {
        await dispatchInboundThroughDebouncer({
          inbound,
          raw: event as SlackDebounceRawInput,
          opts: { source: "app_mention", wasMentioned: true },
        });
      } catch (error) {
        console.error("[Slack] Error handling channel mention:", error);
      }
    });

    const handleNativeChannelSlashCommand = async ({
      command,
      ack,
    }: {
      command: SlackCommandPayload;
      ack: () => Promise<void>;
    }) => {
      await ack();

      if (!adapter.onMessage) {
        return;
      }

      const payload = command;
      if (
        !isNonEmptyString(payload.command) ||
        !isNonEmptyString(payload.channel_id) ||
        !isNonEmptyString(payload.user_id)
      ) {
        return;
      }

      const commandArgs = isNonEmptyString(payload.text)
        ? payload.text.trim()
        : "";
      const commandText = commandArgs
        ? `${payload.command} ${commandArgs}`
        : payload.command;

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId: payload.channel_id,
        senderId: payload.user_id,
        senderTeamId: firstNonEmptyString(payload.team_id),
        senderName: firstNonEmptyString(payload.user_name, payload.user_id),
        chatLabel: firstNonEmptyString(
          payload.channel_name,
          payload.channel_id,
        ),
        text: commandText,
        timestamp: Date.now(),
        messageId: firstNonEmptyString(payload.trigger_id, payload.command),
        threadId: null,
        chatType: resolveSlackChatType(payload.channel_id),
        isMention: false,
        raw: command,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error(
          `[Slack] Error handling ${payload.command} command:`,
          error,
        );
      }
    };

    for (const definition of listChannelSlashCommands()) {
      for (const commandName of [
        definition.name,
        ...(definition.aliases ?? []),
      ]) {
        instance.command(`/${commandName}`, handleNativeChannelSlashCommand);
      }
    }

    const handleModelSelectAction = async ({
      body,
      action,
      ack,
    }: {
      body: unknown;
      action: unknown;
      ack: () => Promise<void>;
    }) => {
      await ack();
      if (!adapter.onMessage) {
        return;
      }

      const selectedModel = resolveSlackSelectedModel(action, body);
      const channelId = resolveSlackActionChannelId(body);
      const user = resolveSlackActionUser(body);
      if (!selectedModel || !channelId || !user.id) {
        return;
      }

      const actionRecord = getSlackActionRecord(action, body);
      const messageId = firstNonEmptyString(
        actionRecord?.action_ts,
        resolveSlackActionMessageId(body),
      );
      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId: channelId,
        senderId: user.id,
        senderTeamId: user.teamId,
        senderName: user.name,
        chatLabel: channelId,
        text: `/model ${selectedModel}`,
        timestamp: Date.now(),
        messageId,
        threadId: resolveSlackActionThreadId(body),
        chatType: resolveSlackChatType(channelId),
        isMention: false,
        raw: body,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error("[Slack] Error handling model select action:", error);
      }
    };

    const actionRegistrar = instance as unknown as {
      action?: (
        actionId: string,
        handler: typeof handleModelSelectAction,
      ) => void;
    };
    actionRegistrar.action?.(
      SLACK_MODEL_SELECT_ACTION_ID,
      handleModelSelectAction,
    );

    const handleReactionEvent = async (
      event: SlackReactionEvent,
      action: "added" | "removed",
    ) => {
      if (!adapter.onMessage) {
        return;
      }

      const item = asRecord(event.item);
      const chatId = item?.channel;
      const targetMessageId = item?.ts;
      if (
        item?.type !== "message" ||
        !isNonEmptyString(chatId) ||
        !isNonEmptyString(targetMessageId) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.reaction)
      ) {
        return;
      }

      if (event.user === botUserId) {
        return;
      }

      const chatType = resolveSlackChatType(chatId);
      const threadId =
        chatType === "channel"
          ? (knownThreadIdsByMessageId.get(targetMessageId) ?? targetMessageId)
          : chatType === "direct"
            ? (knownThreadIdsByMessageId.get(targetMessageId) ?? null)
            : null;

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId,
        senderId: event.user,
        senderTeamId: resolveSlackSenderTeamId(event),
        senderName: await resolveUserName(instance, event.user),
        chatLabel: chatId,
        text: `Slack reaction ${action}: :${event.reaction}:`,
        timestamp: slackTimestampToMillis(
          firstNonEmptyString(event.event_ts, targetMessageId) ??
            targetMessageId,
        ),
        messageId: firstNonEmptyString(event.event_ts, targetMessageId),
        threadId,
        chatType,
        isMention: false,
        reaction: {
          action,
          emoji: event.reaction,
          targetMessageId,
          targetSenderId: isNonEmptyString(event.item_user)
            ? event.item_user
            : undefined,
        },
        raw: event,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error(`[Slack] Error handling reaction ${action}:`, error);
      }
    };

    instance.event("reaction_added", async ({ event }) => {
      await handleReactionEvent(event as SlackReactionEvent, "added");
    });

    instance.event("reaction_removed", async ({ event }) => {
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    });

    app = instance;
    return instance;
  }

  async function ensureWriteClient(): Promise<SlackWriteClient> {
    if (writeClient) {
      return writeClient;
    }

    writeClient = await createSlackWebApiClient<SlackWriteClient>(
      config.botToken,
      {
        retryConfig: {
          retries: 0,
        },
      },
    );
    return writeClient;
  }

  const adapter: ChannelAdapter = {
    id: `slack:${config.accountId}`,
    channelId: "slack",
    accountId: config.accountId,
    name: "Slack",

    async start(): Promise<void> {
      if (running) {
        return;
      }

      const slackApp = await ensureApp();
      const auth = await slackApp.client.auth.test();
      botUserId = isNonEmptyString(auth.user_id) ? auth.user_id : null;
      botTeamId = firstNonEmptyString(auth.team_id) ?? null;
      await slackApp.start();
      running = true;

      console.log(
        `[Slack] App started for workspace ${auth.team ?? "unknown"} (dm_policy: ${config.dmPolicy})`,
      );
    },

    async stop(): Promise<void> {
      if (!app || !running) {
        return;
      }
      await app.stop();
      running = false;
      app = null;
      writeClient = null;
      botUserId = null;
      botTeamId = null;
      seenIngressMessageKeys.clear();
      for (const entry of progressCardByReplyKey.values()) {
        if (entry.pendingTimer) {
          clearTimeout(entry.pendingTimer);
        }
        clearSlackProgressStreamTimers(entry);
      }
      progressCardByReplyKey.clear();
      activeProgressCardKeyByReplyKey.clear();
      assistantStatusReplyKeys.clear();
      assistantStatusTextByReplyKey.clear();
      pendingTopLevelDebounceKeys.clear();
      appMentionRetryKeys.clear();
      appMentionDispatchedKeys.clear();
      agentThreadTracker.clear();
      console.log("[Slack] App stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) {
        return;
      }

      if (event.type === "queued") {
        if (isSlackProgressCardRendering(event.source)) {
          await clearSlackAssistantThreadStatus(event.source);
          return;
        }
        const status = getSlackAssistantThreadStatusForTurn(event.source);
        if (status) {
          await setSlackAssistantThreadStatus(event.source, status);
        }
        return;
      }

      if (event.type === "processing") {
        await Promise.all(
          getUniqueSlackProgressSources(event.sources).map(async (source) => {
            if (configuredProgressUi === "text") {
              // Simple view: the "is working" footer and the dim status
              // placeholder appear together at turn start.
              const replyKey = getLifecycleReplyKey(source);
              const status = getSlackAssistantThreadStatusForTurn(source);
              if (
                status &&
                (!replyKey || !assistantStatusReplyKeys.has(replyKey))
              ) {
                await setSlackAssistantThreadStatus(source, status);
              }
              await upsertSlackProgressCard(source, "processing", "Thinking", {
                force: true,
              });
              return;
            }
            if (isSlackProgressCardRendering(source)) {
              await clearSlackAssistantThreadStatus(source);
              return;
            }
            const replyKey = getLifecycleReplyKey(source);
            if (replyKey && assistantStatusReplyKeys.has(replyKey)) {
              return;
            }
            const status = getSlackAssistantThreadStatusForTurn(source);
            if (status) {
              await setSlackAssistantThreadStatus(source, status);
            }
          }),
        );
        return;
      }

      if (event.outcome === "completed") {
        // Completed lifecycle events can be internal continuation boundaries;
        // the final Slack send still closes the active progress card.
        await flushSlackProgressCardsForCompletedLifecycle(
          event.sources,
          event.batchId,
        );
      } else {
        await finishSlackProgressCards(
          event.sources,
          event.outcome,
          event.batchId,
          event.error,
        );
      }

      if (event.outcome === "error") {
        // Every turn that surfaces as a red "Turn failed" card also emits a
        // telemetry event, so genuine SADs are measurable and separable from
        // cosmetic dead-stream artifacts (slack_progress_stream_dead).
        trackBoundaryError({
          context: "slack channel turn",
          errorType: "slack_channel_turn_error",
          error: event.error?.trim() || "unknown error",
          runId: event.runId ?? undefined,
        });
      }

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) {
        return;
      }

      const uniqueReplySources = new Map<string, ChannelTurnSource>();
      for (const source of event.sources) {
        const key = getLifecycleErrorReplyKey(source);
        if (!key || uniqueReplySources.has(key)) {
          continue;
        }
        uniqueReplySources.set(key, source);
      }

      await Promise.all(
        Array.from(uniqueReplySources.values()).map(async (source) => {
          try {
            await sendLifecycleErrorReply(source, errorText, event.runId);
          } catch (error) {
            console.warn(
              `[Slack] Failed to post lifecycle error for ${source.chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    },

    async handleTurnProgressEvent(
      event: ChannelTurnProgressEvent,
    ): Promise<void> {
      if (!running) {
        return;
      }
      if (!isSlackToolActionProgress(event)) {
        return;
      }
      await Promise.all(
        getUniqueSlackProgressSources(event.sources).map((source) =>
          upsertSlackProgressCard(source, "processing", event.message, {
            update: event,
          }),
        ),
      );
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      if (msg.reaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error(
            "Slack reactions require message_id (or reply_to_message_id) to identify the target message.",
          );
        }
        const emoji = normalizeSlackReactionName(msg.reaction);
        if (!emoji) {
          throw new Error("Slack reaction emoji cannot be empty.");
        }
        if (msg.removeReaction) {
          await slackClient.reactions.remove({
            channel: msg.chatId,
            timestamp: targetMessageId,
            name: emoji,
          });
        } else {
          await slackClient.reactions.add({
            channel: msg.chatId,
            timestamp: targetMessageId,
            name: emoji,
          });
        }
        return { messageId: targetMessageId };
      }

      if (msg.mediaPath) {
        const result = await uploadSlackFile(slackClient, msg);
        const outboundThreadId = msg.threadId ?? msg.replyToMessageId ?? null;
        // Slack's external upload completion returns a file id, not a message
        // timestamp, so top-level file uploads cannot become tracked thread
        // roots. Threaded uploads can still auto-subscribe using the explicit
        // thread id supplied by the caller.
        if (
          resolveSlackChatType(msg.chatId) === "channel" &&
          isNonEmptyString(outboundThreadId)
        ) {
          agentThreadTracker.remember(msg.chatId, outboundThreadId);
        }
        await finishSlackProgressCardForOutboundMessage(msg);
        return result;
      }

      const threadTs = resolveSlackOutboundThreadTs({
        chatId: msg.chatId,
        threadId: msg.threadId,
        replyToMessageId: msg.replyToMessageId,
      });

      // Simple view: when a live status stream exists for this thread, the
      // reply stops the stream and the placeholder becomes the message.
      const streamReplyTs = await maybeFulfillReplyViaStatusStream(msg);
      if (streamReplyTs) {
        const streamThreadId =
          threadTs ??
          (resolveSlackChatType(msg.chatId) === "channel"
            ? streamReplyTs
            : null);
        if (
          resolveSlackChatType(msg.chatId) === "channel" &&
          isNonEmptyString(streamThreadId)
        ) {
          agentThreadTracker.remember(msg.chatId, streamThreadId);
        }
        return { messageId: streamReplyTs };
      }

      // Web deep link: a small context-block footnote under every reply,
      // when the caller supplied the sending identity.
      const footnote =
        isNonEmptyString(msg.agentId) && isNonEmptyString(msg.conversationId)
          ? buildSlackChatFootnote({
              agentId: msg.agentId,
              conversationId: msg.conversationId,
            })
          : "";
      const blocks = footnote
        ? buildSlackReplyBlocksWithFootnote(msg.text, footnote)
        : undefined;
      const response = await slackClient.chat.postMessage({
        channel: msg.chatId,
        text: msg.text,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });

      const outboundThreadId =
        threadTs ??
        (resolveSlackChatType(msg.chatId) === "channel"
          ? (response.ts ?? null)
          : null);
      rememberMessageThread(response.ts, outboundThreadId);

      // Auto-subscribe: track the thread so future user replies in it are
      // picked up without requiring an explicit @mention. For top-level
      // channel posts, the sent message's own ts becomes the thread parent
      // if someone replies to it.
      if (
        resolveSlackChatType(msg.chatId) === "channel" &&
        isNonEmptyString(outboundThreadId)
      ) {
        agentThreadTracker.remember(msg.chatId, outboundThreadId);
      }

      await finishSlackProgressCardForOutboundMessage(msg);

      return { messageId: response.ts ?? "" };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: {
        replyToMessageId?: string;
        threadId?: string | null;
        modelPicker?: ChannelModelPickerData;
      },
    ): Promise<void> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      const threadTs = resolveSlackOutboundThreadTs({
        chatId,
        threadId: options?.threadId,
        replyToMessageId: options?.replyToMessageId,
      });
      const pickerBlocks = options?.modelPicker
        ? buildSlackModelPickerBlocks(options.modelPicker)
        : undefined;
      const response = await slackClient.chat.postMessage({
        channel: chatId,
        text,
        ...(pickerBlocks ? { blocks: asSlackBlocks(pickerBlocks) } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      const outboundThreadId =
        threadTs ??
        (resolveSlackChatType(chatId) === "channel"
          ? (response.ts ?? null)
          : null);
      rememberMessageThread(response.ts, outboundThreadId);

      if (
        resolveSlackChatType(chatId) === "channel" &&
        isNonEmptyString(outboundThreadId)
      ) {
        agentThreadTracker.remember(chatId, outboundThreadId);
      }

      // Direct replies (channel command responses, notices) are bot messages
      // in the thread like any other: if a live progress stream exists there,
      // close it out so the spinner never renders above a newer bot message
      // (LET-9524).
      await finishSlackProgressCardForOutboundMessage({
        channel: "slack",
        chatId,
        text,
        threadId: options?.threadId ?? null,
        replyToMessageId: options?.replyToMessageId,
      });
    },

    async handleControlRequestEvent(
      event: ChannelControlRequestEvent,
    ): Promise<void> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      const text = formatChannelControlRequestPrompt(event);
      const blocks = formatSlackControlRequestBlocks(event);
      const threadTs = resolveSlackSourceThreadTs(event.source);
      const response = await slackClient.chat.postMessage({
        channel: event.source.chatId,
        text,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      const outboundThreadId =
        threadTs ??
        (resolveSlackChatType(event.source.chatId) === "channel"
          ? (response.ts ?? null)
          : null);
      rememberMessageThread(response.ts, outboundThreadId);

      if (
        resolveSlackChatType(event.source.chatId) === "channel" &&
        isNonEmptyString(outboundThreadId)
      ) {
        agentThreadTracker.remember(event.source.chatId, outboundThreadId);
      }
    },

    async prepareInboundMessage(
      msg: InboundChannelMessage,
      options?: { isFirstRouteTurn?: boolean },
    ): Promise<InboundChannelMessage> {
      if (
        msg.channel !== "slack" ||
        !isNonEmptyString(msg.threadId) ||
        !isNonEmptyString(msg.messageId)
      ) {
        return msg;
      }

      const isFirstRouteTurn = options?.isFirstRouteTurn === true;
      const shouldHydrateExistingThreadContext = msg.threadId !== msg.messageId;
      const shouldHydrateChannelBootstrapContext =
        isFirstRouteTurn &&
        msg.isMention === true &&
        msg.threadId === msg.messageId;

      if (
        !shouldHydrateExistingThreadContext &&
        !shouldHydrateChannelBootstrapContext
      ) {
        return msg;
      }

      const slackApp = await ensureApp();
      const threadAttachmentParams = {
        accountId: config.accountId,
        token: config.botToken,
        transcribeVoice: config.transcribeVoice === true,
      };
      const starter =
        shouldHydrateExistingThreadContext && isFirstRouteTurn
          ? await resolveSlackThreadStarter({
              channelId: msg.chatId,
              threadTs: msg.threadId,
              client: slackApp.client,
              ...threadAttachmentParams,
            })
          : null;
      const resolvedHistory = shouldHydrateExistingThreadContext
        ? await resolveSlackThreadHistory({
            channelId: msg.chatId,
            threadTs: msg.threadId,
            client: slackApp.client,
            currentMessageTs: msg.messageId,
            limit: INITIAL_SLACK_THREAD_HISTORY_LIMIT,
            ...threadAttachmentParams,
          })
        : await resolveSlackChannelHistory({
            channelId: msg.chatId,
            beforeTs: msg.messageId,
            client: slackApp.client,
            limit: INITIAL_SLACK_THREAD_HISTORY_LIMIT,
            ...threadAttachmentParams,
          });
      // Existing routed thread turns already deliver human messages into the
      // Letta conversation. Bot-authored Slack messages are intentionally not
      // runnable input, so rehydrate those skipped entries as context on the
      // next human turn instead of waking the agent for every bot event.
      const history =
        shouldHydrateExistingThreadContext && !isFirstRouteTurn
          ? resolvedHistory.filter((entry) => isNonEmptyString(entry.botId))
          : resolvedHistory;

      if (!starter && history.length === 0) {
        return msg;
      }

      const uniqueUserIds = new Set<string>();
      if (isNonEmptyString(starter?.userId)) {
        uniqueUserIds.add(starter.userId);
      }
      for (const entry of history) {
        if (isNonEmptyString(entry.userId)) {
          uniqueUserIds.add(entry.userId);
        }
      }

      await Promise.all(
        Array.from(uniqueUserIds).map(async (userId) => {
          await resolveUserName(slackApp, userId);
        }),
      );

      const resolveThreadSenderName = (
        userId?: string,
        botId?: string,
      ): string | undefined => {
        if (isNonEmptyString(userId)) {
          return knownUserDisplayNames.get(userId) ?? userId;
        }
        if (isNonEmptyString(botId)) {
          return `Bot (${botId})`;
        }
        return undefined;
      };

      return {
        ...msg,
        threadContext: {
          label: shouldHydrateExistingThreadContext
            ? buildSlackThreadLabel(msg, starter?.text)
            : buildSlackChannelContextLabel(msg),
          ...(starter
            ? {
                starter: {
                  messageId: starter.ts,
                  senderId: starter.userId ?? starter.botId,
                  senderName: resolveThreadSenderName(
                    starter.userId,
                    starter.botId,
                  ),
                  text: starter.text,
                  ...(starter.attachments?.length
                    ? { attachments: starter.attachments }
                    : {}),
                },
              }
            : {}),
          ...(history.length > 0
            ? {
                history: history.map((entry) => ({
                  messageId: entry.ts,
                  senderId: entry.userId ?? entry.botId,
                  senderName: resolveThreadSenderName(
                    entry.userId,
                    entry.botId,
                  ),
                  text: entry.text,
                  ...(entry.attachments?.length
                    ? { attachments: entry.attachments }
                    : {}),
                })),
              }
            : {}),
        },
      };
    },

    onMessage: undefined,
  };

  return adapter;
}
