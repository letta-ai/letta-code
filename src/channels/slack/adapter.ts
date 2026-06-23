import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type SlackApp from "@slack/bolt";
import { listChannelSlashCommands } from "@/channels/commands";
import {
  createInboundDebouncer,
  type InboundDebouncer,
} from "@/channels/inbound-debounce";
import { formatChannelControlRequestPrompt } from "@/channels/interactive";
import { formatChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnOutcome,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  SlackChannelAccount,
} from "@/channels/types";
import { buildChatUrl, isLocalAgentId } from "@/cli/helpers/app-urls";
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

type SlackBlockElement = {
  type: "button";
  text: SlackTextObject;
  url: string;
  action_id: string;
};

type SlackBlock =
  | {
      type: "section";
      text: SlackTextObject;
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

function normalizeSlackReactionName(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "");
}

const SLACK_INGRESS_DEDUPE_TTL_MS = 60_000;
const SLACK_INGRESS_DEDUPE_MAX = 2_000;
const SLACK_LIFECYCLE_ERROR_TEXT_MAX = 3_000;
const SLACK_PROGRESS_CARD_TEXT_MAX = 300;
const SLACK_PROGRESS_CARD_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const SLACK_PROGRESS_CARD_STATE_MAX = 2_000;
const SLACK_ASSISTANT_STATUS_TEXT_MAX = 100;
const SLACK_STREAM_CHUNK_TEXT_MAX = 256;
const DEFAULT_SLACK_PROGRESS_UPDATE_THROTTLE_MS = 1_000;

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
  title: string;
  status: SlackStreamTaskStatus;
};

type SlackProgressCardEntry = {
  source: ChannelTurnSource;
  mode?: "stream" | "fallback";
  streamTs?: string;
  fallbackMessageTs?: string;
  status: SlackProgressCardState;
  latestText: string;
  latestUpdate?: ChannelTurnProgressEvent;
  toolNamesByCallId?: Map<string, string>;
  toolTitlesByCallId?: Map<string, string>;
  toolTasksById?: Map<string, SlackProgressToolTask>;
  pendingStreamChunks?: SlackStreamChunk[];
  hiddenToolCallIds?: Set<string>;
  lastSentText?: string;
  lastSentAt: number;
  pendingTimer?: ReturnType<typeof setTimeout>;
  pendingFlush?: Promise<void>;
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

function replaceSlackControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = character.charCodeAt(0);
    result += code <= 31 || code === 127 ? " " : character;
  }
  return result;
}

function sanitizeSlackProgressText(text: string, maxLength: number): string {
  const redacted = text.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
    "$1=[redacted]",
  );
  const normalized = replaceSlackControlCharacters(redacted)
    .replace(/[<>]/g, "")
    .replace(/&/g, "and")
    .replace(/@(?=channel|here|everyone|[A-Za-z0-9._-]+)/gi, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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

function formatSlackFallbackProgressBlocks(
  status: SlackProgressCardState,
  progressText: string,
): SlackBlock[] {
  const safeProgressText = sanitizeSlackProgressText(
    progressText,
    SLACK_PROGRESS_CARD_TEXT_MAX,
  );
  const heading =
    status === "processing"
      ? "*Letta Code is working*"
      : status === "completed"
        ? "*Letta Code finished*"
        : status === "cancelled"
          ? "*Letta Code stopped*"
          : "*Letta Code hit an error*";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: safeProgressText ? `${heading}\n${safeProgressText}` : heading,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Live progress from Letta Code",
        },
      ],
    },
  ];
}

function buildSlackConversationUrl(source: ChannelTurnSource): string | null {
  if (isLocalAgentId(source.agentId)) {
    return null;
  }
  const url = buildChatUrl(source.agentId, {
    conversationId: source.conversationId,
  });
  return url;
}

function buildSlackConversationButtonBlocks(
  source: ChannelTurnSource,
): SlackBlock[] {
  const url = buildSlackConversationUrl(source);
  if (!url) {
    return [];
  }
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open conversation",
            emoji: false,
          },
          url,
          action_id: "open_conversation",
        },
      ],
    },
  ];
}

function buildTerminalSlackStreamChunks(
  entry: SlackProgressCardEntry,
  terminalTaskStatus: SlackStreamTaskStatus,
): SlackStreamChunk[] {
  const chunks: SlackStreamChunk[] = [...(entry.pendingStreamChunks ?? [])];
  for (const task of entry.toolTasksById?.values() ?? []) {
    if (task.status === "complete" || task.status === "error") {
      continue;
    }
    const terminalTask = {
      ...task,
      title: formatSlackToolTitleForTerminalStatus(
        task.title,
        terminalTaskStatus,
      ),
      status: terminalTaskStatus,
    };
    chunks.push({ type: "task_update", ...terminalTask });
    entry.toolTasksById?.set(task.id, terminalTask);
  }
  const buttonBlocks =
    entry.status === "completed"
      ? buildSlackConversationButtonBlocks(entry.source)
      : [];
  if (buttonBlocks.length > 0) {
    chunks.push({ type: "blocks", blocks: buttonBlocks });
  }
  return chunks;
}

function isSlackToolActionProgress(update: ChannelTurnProgressEvent): boolean {
  return update.kind === "tool" || update.kind === "approval";
}

function isSlackHiddenToolName(toolName: string): boolean {
  return toolName.toLowerCase() === "messagechannel";
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
    entry.toolTitlesByCallId?.delete(update.toolCallId);
    return;
  }
  if (update.toolName) {
    entry.toolNamesByCallId ??= new Map();
    entry.toolNamesByCallId.set(update.toolCallId, update.toolName);
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

function formatSlackToolTitleForState(
  title: string,
  update: ChannelTurnProgressEvent,
): string {
  if (update.state === "completed" && title.startsWith("Searching ")) {
    return `Searched ${title.slice("Searching ".length)}`;
  }
  if (update.state === "error" && title.startsWith("Searching ")) {
    return `Attempted to search ${title.slice("Searching ".length)}`;
  }
  return title;
}

function formatSlackToolTitleForTerminalStatus(
  title: string,
  status: SlackStreamTaskStatus,
): string {
  if (status === "complete" && title.startsWith("Searching ")) {
    return `Searched ${title.slice("Searching ".length)}`;
  }
  if (status === "error" && title.startsWith("Searching ")) {
    return `Attempted to search ${title.slice("Searching ".length)}`;
  }
  return title;
}

function resolveSlackToolActionName(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
): string | null {
  if (update.toolCallId && entry.hiddenToolCallIds?.has(update.toolCallId)) {
    return null;
  }
  const rememberedTitle = update.toolCallId
    ? entry.toolTitlesByCallId?.get(update.toolCallId)
    : undefined;
  const toolTitle = update.toolTitle ?? rememberedTitle;
  if (toolTitle) {
    return sanitizeSlackProgressText(
      formatSlackToolTitleForState(toolTitle, update),
      SLACK_STREAM_CHUNK_TEXT_MAX,
    );
  }
  if (update.toolName) {
    if (isSlackHiddenToolName(update.toolName)) {
      return null;
    }
    return sanitizeSlackProgressText(
      update.toolName,
      SLACK_STREAM_CHUNK_TEXT_MAX,
    );
  }
  const rememberedName = update.toolCallId
    ? entry.toolNamesByCallId?.get(update.toolCallId)
    : undefined;
  if (rememberedName) {
    return sanitizeSlackProgressText(
      rememberedName,
      SLACK_STREAM_CHUNK_TEXT_MAX,
    );
  }
  if (update.kind === "tool") {
    return null;
  }
  const raw =
    update.command ?? (update.kind === "approval" ? "Tool approval" : null);
  if (!raw) {
    return null;
  }
  return sanitizeSlackProgressText(raw, SLACK_STREAM_CHUNK_TEXT_MAX);
}

function resolveSlackToolActionTaskId(
  update: ChannelTurnProgressEvent,
): string | null {
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
  return `task_${trimmed || "tool"}`;
}

function toSlackStreamTaskStatus(
  update: ChannelTurnProgressEvent,
): SlackStreamTaskStatus {
  if (update.state === "error") {
    return "error";
  }
  if (update.state === "completed") {
    return "complete";
  }
  if (update.state === "waiting") {
    return "pending";
  }
  return "in_progress";
}

function buildSlackStreamProgressChunks(
  entry: SlackProgressCardEntry,
  update: ChannelTurnProgressEvent,
): SlackStreamChunk[] {
  // Slack replaces task rows that reuse an id, so visible tool calls need
  // stable per-call task ids to preserve parallel tool history in the card.
  const id = resolveSlackToolActionTaskId(update);
  if (!id) {
    return [];
  }
  const title = resolveSlackToolActionName(entry, update);
  if (!title) {
    return [];
  }
  const status = toSlackStreamTaskStatus(update);
  const task = { id, title, status };
  entry.toolTasksById ??= new Map();
  entry.toolTasksById.set(id, task);

  return [
    {
      type: "task_update",
      ...task,
    },
  ];
}

function formatSlackAssistantStatusText(
  status: SlackProgressCardState,
  progressText: string,
): string {
  const fallback =
    status === "processing"
      ? "Working on it"
      : status === "completed"
        ? "Done"
        : status === "cancelled"
          ? "Stopped"
          : "Error";
  return sanitizeSlackProgressText(
    progressText || fallback,
    SLACK_ASSISTANT_STATUS_TEXT_MAX,
  );
}

function resolveSlackLifecycleProgressText(outcome: ChannelTurnOutcome): {
  status: SlackProgressCardState;
  text: string;
} {
  if (outcome === "completed") {
    return { status: "completed", text: "Completed" };
  }
  if (outcome === "cancelled") {
    return { status: "cancelled", text: "Cancelled" };
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

  const completeResp = await slackClient.files.completeUploadExternal({
    files: [{ id: uploadUrlResp.file_id, title: uploadTitle }],
    channel_id: msg.chatId,
    ...(msg.text.trim() ? { initial_comment: msg.text } : {}),
    ...((msg.threadId ?? msg.replyToMessageId)
      ? { thread_ts: msg.threadId ?? msg.replyToMessageId }
      : {}),
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
  if (msg.chatType !== "channel") {
    return undefined;
  }

  const roomLabel =
    isNonEmptyString(msg.chatLabel) && msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";
  const preview = truncateSlackThreadLabel(starterText ?? msg.text);
  if (preview) {
    return `Slack thread${roomLabel}: ${preview}`;
  }
  return roomLabel ? `Slack thread${roomLabel}` : `Slack thread ${msg.chatId}`;
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
  const progressUpdateThrottleMs = resolveSlackProgressUpdateThrottleMs();

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

  const debouncer: InboundDebouncer<SlackDebounceEntry> =
    createInboundDebouncer<SlackDebounceEntry>({
      debounceMs,
      buildKey: ({ raw }) => buildSlackDebounceKey(raw, config.accountId),
      shouldDebounce: ({ inbound }) =>
        !inbound.attachments?.length && !inbound.reaction,
      onFlush: async (entries) => {
        const last = entries[entries.length - 1];
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
          entries.length === 1
            ? last.inbound.text
            : entries
                .map((entry) => entry.inbound.text)
                .filter((text) => text && text.length > 0)
                .join("\n");
        const combinedMentioned = entries.some(
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
    const replyToMessageId = source.threadId ?? source.messageId;
    if (!isNonEmptyString(replyToMessageId)) {
      return null;
    }
    return `${source.chatId}:${replyToMessageId}`;
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
    const replyToMessageId = source.threadId ?? source.messageId;
    if (!isNonEmptyString(replyToMessageId)) {
      return;
    }

    await ensureApp();
    const slackClient = await ensureWriteClient();
    const response = await slackClient.chat.postMessage({
      channel: source.chatId,
      text: formatSlackLifecycleErrorMessage(errorText, runId),
      thread_ts: replyToMessageId,
    });
    rememberMessageThread(response.ts, replyToMessageId);
  }

  function getSlackProgressReplyKey(source: ChannelTurnSource): string | null {
    return getLifecycleReplyKey(source);
  }

  function getSlackProgressReplyTs(source: ChannelTurnSource): string | null {
    const replyToMessageId = source.threadId ?? source.messageId;
    return isNonEmptyString(replyToMessageId) ? replyToMessageId : null;
  }

  function getUniqueSlackProgressSources(
    sources: ChannelTurnSource[],
  ): ChannelTurnSource[] {
    const seen = new Set<string>();
    const unique: ChannelTurnSource[] = [];
    for (const source of sources) {
      const key = getSlackProgressReplyKey(source);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(source);
    }
    return unique;
  }

  async function setSlackAssistantThreadStatus(
    source: ChannelTurnSource,
    status: SlackProgressCardState,
    progressText: string,
  ): Promise<void> {
    const threadTs = getSlackProgressReplyTs(source);
    if (!threadTs) {
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
        status: formatSlackAssistantStatusText(status, progressText),
      });
    } catch (error) {
      console.warn(
        "[Slack] Failed to set assistant thread status:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function clearSlackAssistantThreadStatus(
    source: ChannelTurnSource,
  ): Promise<void> {
    const threadTs = getSlackProgressReplyTs(source);
    if (!threadTs) {
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
        status: "",
      });
    } catch (error) {
      console.warn(
        "[Slack] Failed to clear assistant thread status:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  function canStartSlackStream(source: ChannelTurnSource): boolean {
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
  ): SlackStartStreamArgs {
    const initialChunks = [...(entry.pendingStreamChunks ?? [])];
    const args: SlackStartStreamArgs = {
      channel: entry.source.chatId,
      thread_ts: replyToMessageId,
      task_display_mode: "dense",
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

  async function startSlackProgressStream(
    entry: SlackProgressCardEntry,
    replyToMessageId: string,
  ): Promise<boolean> {
    if (!canStartSlackStream(entry.source)) {
      return false;
    }
    if (!entry.pendingStreamChunks || entry.pendingStreamChunks.length === 0) {
      return true;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    const startStream = slackClient.chat.startStream;
    if (!startStream) {
      return false;
    }
    try {
      const args = buildSlackStartStreamArgs(entry, replyToMessageId);
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
      rememberMessageThread(response.ts, replyToMessageId);
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to start progress stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async function appendSlackProgressStream(
    entry: SlackProgressCardEntry,
  ): Promise<boolean> {
    if (!entry.streamTs) {
      return true;
    }
    const chunks = [...(entry.pendingStreamChunks ?? [])];
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
        console.warn(
          "[Slack] Failed to append progress stream:",
          response.error ?? "unknown error",
        );
        return false;
      }
      return true;
    } catch (error) {
      console.warn(
        "[Slack] Failed to append progress stream:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  async function stopSlackProgressStream(
    entry: SlackProgressCardEntry,
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
    const terminalTaskStatus: SlackStreamTaskStatus =
      entry.status === "error"
        ? "error"
        : entry.status === "cancelled"
          ? "error"
          : "complete";
    const chunks = buildTerminalSlackStreamChunks(entry, terminalTaskStatus);
    try {
      const args: SlackStopStreamArgs = {
        channel: entry.source.chatId,
        ts: entry.streamTs,
      };
      if (chunks.length > 0) {
        args.chunks = chunks;
      }
      const response = await stopStream.call(slackClient.chat, args);
      if (response.ok === false) {
        console.warn(
          "[Slack] Failed to stop progress stream:",
          response.error ?? "unknown error",
        );
        return false;
      }
      return true;
    } catch (error) {
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

  async function flushSlackFallbackProgressCard(
    entry: SlackProgressCardEntry,
    replyToMessageId: string,
    text: string,
  ): Promise<void> {
    const blocks = formatSlackFallbackProgressBlocks(
      entry.status,
      entry.latestText,
    );
    await ensureApp();
    const slackClient = await ensureWriteClient();
    if (!entry.fallbackMessageTs) {
      const response = await slackClient.chat.postMessage({
        channel: entry.source.chatId,
        text,
        blocks,
        thread_ts: replyToMessageId,
      });
      if (response.ts) {
        entry.fallbackMessageTs = response.ts;
        rememberMessageThread(response.ts, replyToMessageId);
      }
      entry.mode = "fallback";
      return;
    }

    const response = await slackClient.chat.update({
      channel: entry.source.chatId,
      ts: entry.fallbackMessageTs,
      text,
      blocks,
    });
    if (response.ts) {
      entry.fallbackMessageTs = response.ts;
    }
    entry.mode = "fallback";
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
        entry.lastSentText !== latestText ||
        (entry.pendingStreamChunks?.length ?? 0) > 0
      ) {
        await flushSlackProgressCard(key, entry);
      }
      return;
    }

    const operation = (async () => {
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
        (entry.pendingStreamChunks?.length ?? 0) === 0
      ) {
        entry.lastSentAt = Date.now();
        return;
      }

      if (entry.status === "processing") {
        await setSlackAssistantThreadStatus(
          entry.source,
          entry.status,
          entry.latestText,
        );
      }

      if (!entry.mode) {
        const didStartStream = await startSlackProgressStream(
          entry,
          replyToMessageId,
        );
        if (!didStartStream) {
          await flushSlackFallbackProgressCard(entry, replyToMessageId, text);
        }
      } else if (entry.mode === "stream") {
        const didAppend = await appendSlackProgressStream(entry);
        if (!didAppend) {
          // If appending fails after Slack accepted the stream, close that
          // native stream before switching surfaces. Otherwise Slack can keep
          // showing an active task card while the fallback card continues.
          await stopSlackProgressStream(entry);
          entry.mode = "fallback";
          await flushSlackFallbackProgressCard(entry, replyToMessageId, text);
        }
      } else {
        await flushSlackFallbackProgressCard(entry, replyToMessageId, text);
      }

      delete entry.latestUpdate;
      entry.pendingStreamChunks = [];
      entry.lastSentText = text;
      entry.lastSentAt = Date.now();
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
  }

  function pruneSlackProgressCardState(now: number = Date.now()): void {
    for (const [key, entry] of progressCardByReplyKey) {
      if (
        !entry.pendingTimer &&
        !entry.pendingFlush &&
        entry.updatedAt + SLACK_PROGRESS_CARD_STATE_TTL_MS <= now
      ) {
        progressCardByReplyKey.delete(key);
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
      if (entry.pendingTimer || entry.pendingFlush) {
        continue;
      }
      progressCardByReplyKey.delete(key);
      removed += 1;
    }
  }

  async function upsertSlackProgressCard(
    source: ChannelTurnSource,
    status: SlackProgressCardState,
    progressText: string,
    options: { force?: boolean; update?: ChannelTurnProgressEvent } = {},
  ): Promise<void> {
    const key = getSlackProgressReplyKey(source);
    if (!key) {
      return;
    }
    const now = Date.now();
    pruneSlackProgressCardState(now);
    const existingEntry = progressCardByReplyKey.get(key);
    if (options.update?.kind === "tool") {
      if (isSlackHiddenToolUpdate(existingEntry, options.update)) {
        return;
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
    rememberSlackToolName(entry, options.update);
    const streamChunks = options.update
      ? buildSlackStreamProgressChunks(entry, options.update)
      : [];
    if (options.update && streamChunks.length === 0) {
      return;
    }
    if (streamChunks.length > 0) {
      entry.pendingStreamChunks ??= [];
      entry.pendingStreamChunks.push(...streamChunks);
    }
    entry.updatedAt = now;
    progressCardByReplyKey.set(key, entry);

    if (options.force && entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = undefined;
    }
    const elapsed = now - entry.lastSentAt;
    if (
      options.force ||
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
  ): Promise<void> {
    const progress = resolveSlackLifecycleProgressText(outcome);
    const uniqueSources = getUniqueSlackProgressSources(sources);
    await Promise.all(
      uniqueSources.map(async (source) => {
        const key = getSlackProgressReplyKey(source);
        const entry = key ? progressCardByReplyKey.get(key) : undefined;
        if (!entry) {
          await clearSlackAssistantThreadStatus(source);
          return;
        }
        if (entry.pendingTimer) {
          clearTimeout(entry.pendingTimer);
          entry.pendingTimer = undefined;
        }
        entry.source = source;
        entry.status = progress.status;
        entry.latestText = progress.text;
        delete entry.latestUpdate;
        entry.updatedAt = Date.now();
        if (entry.mode === "stream") {
          const didStop = await stopSlackProgressStream(entry);
          if (didStop) {
            entry.lastSentText = formatSlackProgressCardText(
              entry.status,
              entry.latestText,
            );
            entry.lastSentAt = Date.now();
          } else {
            entry.mode = "fallback";
            await upsertSlackProgressCard(
              source,
              progress.status,
              progress.text,
              {
                force: true,
              },
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
        await clearSlackAssistantThreadStatus(source);
      }),
    );
  }

  async function finishSlackProgressCardForOutboundMessage(
    msg: OutboundChannelMessage,
  ): Promise<void> {
    if (msg.channel !== "slack" || msg.reaction) {
      return;
    }
    const replyToMessageId = msg.threadId ?? msg.replyToMessageId;
    if (!isNonEmptyString(replyToMessageId)) {
      return;
    }
    const entry = progressCardByReplyKey.get(
      `${msg.chatId}:${replyToMessageId}`,
    );
    if (!entry) {
      return;
    }

    try {
      await finishSlackProgressCards([entry.source], "completed");
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
        chatType === "channel"
          ? (firstNonEmptyString(rawMessage.thread_ts, rawMessage.ts) ?? null)
          : null;
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
          text,
          timestamp: slackTimestampToMillis(rawMessage.ts),
          messageId: rawMessage.ts,
          threadId: null,
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
      }
      progressCardByReplyKey.clear();
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
        return;
      }

      if (event.type === "processing") {
        // Do not show a task card for every turn. The Slack task surface is
        // reserved for actual tool activity; no-tool replies should render as
        // the assistant response only.
        return;
      }

      await finishSlackProgressCards(event.sources, event.outcome);

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) {
        return;
      }

      const uniqueReplySources = new Map<string, ChannelTurnSource>();
      for (const source of event.sources) {
        const key = getLifecycleReplyKey(source);
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

      const response = await slackClient.chat.postMessage({
        channel: msg.chatId,
        text: msg.text,
        ...((msg.threadId ?? msg.replyToMessageId)
          ? { thread_ts: msg.threadId ?? msg.replyToMessageId }
          : {}),
      });

      const outboundThreadId =
        msg.threadId ?? msg.replyToMessageId ?? response.ts ?? null;
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
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      const response = await slackClient.chat.postMessage({
        channel: chatId,
        text,
        ...(options?.replyToMessageId
          ? { thread_ts: options.replyToMessageId }
          : {}),
      });
      const outboundThreadId = options?.replyToMessageId ?? response.ts ?? null;
      rememberMessageThread(response.ts, outboundThreadId);

      if (
        resolveSlackChatType(chatId) === "channel" &&
        isNonEmptyString(outboundThreadId)
      ) {
        agentThreadTracker.remember(chatId, outboundThreadId);
      }
    },

    async handleControlRequestEvent(
      event: ChannelControlRequestEvent,
    ): Promise<void> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      const response = await slackClient.chat.postMessage({
        channel: event.source.chatId,
        text: formatChannelControlRequestPrompt(event),
        ...((event.source.threadId ?? event.source.messageId)
          ? { thread_ts: event.source.threadId ?? event.source.messageId }
          : {}),
      });
      const outboundThreadId =
        event.source.threadId ?? event.source.messageId ?? response.ts ?? null;
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
        msg.chatType !== "channel" ||
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
