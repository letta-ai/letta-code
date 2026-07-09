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
import { normalizeChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import {
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
  ChannelTurnProgressEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  SlackChannelAccount,
} from "@/channels/types";
import {
  getDisplayToolName,
  isShellTool,
  isTaskTool,
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

type SlackApprovalActionPayload = {
  requestId?: string;
  decision?: "allow" | "deny";
};

type SlackApprovalPromptState = {
  source: ChannelTurnSource;
  messageTs: string;
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
  action_id: string;
  url?: string;
  value?: string;
  style?: "primary" | "danger";
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
      // Block Kit markdown block (built for AI responses): Slack translates
      // standard markdown natively, and unlike section blocks the client
      // renders it in full instead of clamping each block behind "Show more".
      type: "markdown";
      text: string;
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

const SLACK_ASSISTANT_STARTUP_STATUS = "is thinking...";
// Footer text while the simple view is doing visible work. The inline dim
// line carries the current tool description via loading_messages — the two
// setStatus params render on different surfaces (footer vs inline line).
const SLACK_ASSISTANT_WORKING_STATUS = "is working...";
// Slack removes an assistant status ~2 minutes after the last call if no
// message has been sent; re-issue it well inside that window so long tools
// keep their status line.
const SLACK_ASSISTANT_STATUS_KEEPALIVE_MS = 90_000;

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

function normalizeSlackReactionName(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "");
}

const SLACK_INGRESS_DEDUPE_TTL_MS = 60_000;
const SLACK_INGRESS_DEDUPE_MAX = 2_000;
const SLACK_LIFECYCLE_ERROR_TEXT_MAX = 3_000;
const SLACK_STATUS_TEXT_MAX = 300;
const SLACK_APPROVAL_ACTION_ID = "letta_channel_approval";
const SLACK_AGENT_THREAD_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_AGENT_THREAD_MAX = 2_000;

type AgentConvSlackState = {
  isThinkingActive: boolean;
  thinkingText: string;
  typingFooterText: string;
};

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

// Slack markdown blocks cap standard-markdown text at 12,000 characters.
const SLACK_MARKDOWN_BLOCK_TEXT_MAX = 12_000;

/**
 * Render an outbound reply as a markdown block (the Block Kit block built
 * for AI responses — Slack translates standard markdown natively) with a
 * small context footnote (web deep link) below it. Section blocks are wrong
 * here: the client clamps EACH section at a few rendered lines with its own
 * "Show more", so long replies split across sections collapsed into
 * unreadable accordions (live-verified 2026-07-09; a single markdown block
 * renders the same body in full). Returns undefined when the text cannot be
 * represented within Slack's 50-block limit, in which case the caller falls
 * back to plain text without the footnote.
 */
function buildSlackReplyBlocksWithFootnote(
  text: string,
  footnote: string,
): SlackBlock[] | undefined {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MARKDOWN_BLOCK_TEXT_MAX) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", SLACK_MARKDOWN_BLOCK_TEXT_MAX);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", SLACK_MARKDOWN_BLOCK_TEXT_MAX);
    }
    if (cut <= 0) {
      cut = SLACK_MARKDOWN_BLOCK_TEXT_MAX;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  const markdownChunks = chunks.filter((chunk) => chunk.trim().length > 0);
  // Slack allows at most 50 blocks per message; leave room for the footnote.
  if (markdownChunks.length === 0 || markdownChunks.length > 49) {
    return undefined;
  }
  const blocks: SlackBlock[] = markdownChunks.map((chunk) => ({
    type: "markdown",
    text: chunk,
  }));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footnote }],
  });
  return blocks;
}

function sanitizeSlackStatusText(text: string, maxLength: number): string {
  const normalized = sanitizeChannelProgressCore(text)
    .replace(/[<>]/g, "")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
  return truncateChannelProgressText(normalized, maxLength, "...");
}

function isSlackMessageChannelToolName(toolName: string): boolean {
  return toolName.toLowerCase() === "messagechannel";
}

function formatSlackToolNameForDisplay(toolName: string): string {
  return isTaskTool(toolName) ? "Subagent" : getDisplayToolName(toolName);
}

function resolveSlackConcreteActivity(
  event: ChannelTurnProgressEvent,
): string | null {
  if (event.kind === "command" && isNonEmptyString(event.command)) {
    return sanitizeSlackStatusText(
      formatSlackToolNameForDisplay(event.command),
      SLACK_STATUS_TEXT_MAX,
    );
  }
  if (
    event.kind !== "tool" ||
    !isNonEmptyString(event.toolName) ||
    isSlackMessageChannelToolName(event.toolName)
  ) {
    return null;
  }

  for (const description of [
    event.toolTitle,
    event.toolDetails,
    isShellTool(event.toolName) ? event.message : undefined,
    formatSlackToolNameForDisplay(event.toolName),
  ]) {
    if (!isNonEmptyString(description)) {
      continue;
    }
    const sanitized = sanitizeSlackStatusText(
      description,
      SLACK_STATUS_TEXT_MAX,
    );
    if (sanitized) {
      return sanitized;
    }
  }
  return null;
}

function formatSlackControlRequestBlocks(
  event: ChannelControlRequestEvent,
): SlackBlock[] | undefined {
  if (event.kind !== "generic_tool_approval") {
    return undefined;
  }

  const toolName =
    sanitizeSlackStatusText(
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
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          value: JSON.stringify({
            requestId: event.requestId,
            decision: "allow",
          } satisfies SlackApprovalActionPayload),
        },
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          text: { type: "plain_text", text: "Deny", emoji: true },
          style: "danger",
          value: JSON.stringify({
            requestId: event.requestId,
            decision: "deny",
          } satisfies SlackApprovalActionPayload),
        },
      ],
    },
  ];
}

function parseSlackApprovalActionPayload(
  value: unknown,
): { requestId: string; decision: "allow" | "deny" } | null {
  if (!isNonEmptyString(value)) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as SlackApprovalActionPayload;
    if (
      !isNonEmptyString(parsed.requestId) ||
      (parsed.decision !== "allow" && parsed.decision !== "deny")
    ) {
      return null;
    }
    return { requestId: parsed.requestId, decision: parsed.decision };
  } catch {
    return null;
  }
}

function buildSlackApprovalDecisionBlocks(text: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
}

function shouldPostSlackTerminalError(stopReason: string): boolean {
  return !["end_turn", "cancelled", "requires_approval", "tool_rule"].includes(
    stopReason,
  );
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
  let writeClientPromise: Promise<SlackWriteClient> | null = null;
  let running = false;
  let botUserId: string | null = null;
  const knownThreadIdsByMessageId = new Map<string, string | null>();
  const knownUserDisplayNames = new Map<string, string>();
  const seenIngressMessageKeys = new Map<string, number>();
  // Tracks threads the agent has sent messages to so that inbound replies in
  // those threads are auto-routed without requiring an explicit @mention.
  const agentThreadTracker = createAgentThreadTracker();
  const slackStateByAgentConversation = new Map<string, AgentConvSlackState>();
  const statusSourceByAgentConversation = new Map<string, ChannelTurnSource>();
  const statusSignatureByAgentConversation = new Map<string, string>();
  const statusWritePromiseByAgentConversation = new Map<
    string,
    Promise<void>
  >();
  const statusKeepaliveByAgentConversation = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const approvalPromptByRequestId = new Map<string, SlackApprovalPromptState>();
  const clearedStaleAssistantStatusReplyKeys = new Set<string>();
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

  function formatSlackLifecycleErrorMessage(errorText: string): string {
    return truncateChannelProgressText(
      normalizeChannelLifecycleErrorMessage(errorText),
      SLACK_LIFECYCLE_ERROR_TEXT_MAX,
      "...",
    );
  }

  async function sendLifecycleErrorReply(
    source: ChannelTurnSource,
    errorText: string,
  ): Promise<void> {
    const replyToMessageId = resolveSlackSourceThreadTs(source);
    const text = formatSlackLifecycleErrorMessage(errorText);
    const footnote = buildSlackChatFootnote(source);
    const blocks = footnote
      ? buildSlackReplyBlocksWithFootnote(text, footnote)
      : undefined;

    await ensureApp();
    const slackClient = await ensureWriteClient();
    const response = await slackClient.chat.postMessage({
      channel: source.chatId,
      text,
      ...(blocks ? { blocks } : {}),
      ...(replyToMessageId ? { thread_ts: replyToMessageId } : {}),
    });
    rememberMessageThread(response.ts, replyToMessageId ?? null);
  }

  function getAgentConversationSlackKey(
    source: ChannelTurnSource,
  ): string | null {
    if (
      source.channel !== "slack" ||
      !isNonEmptyString(source.agentId) ||
      !isNonEmptyString(source.conversationId)
    ) {
      return null;
    }
    return `${source.agentId}:${source.conversationId}`;
  }

  function getUniqueSlackStatusSources(
    sources: ChannelTurnSource[],
  ): ChannelTurnSource[] {
    const seen = new Set<string>();
    const unique: ChannelTurnSource[] = [];
    for (const source of sources) {
      const key = getAgentConversationSlackKey(source);
      if (!key || seen.has(key) || !getLifecycleReplyKey(source)) {
        continue;
      }
      seen.add(key);
      unique.push(source);
    }
    return unique;
  }

  function isSlackFlatChannelThreadOpener(source: ChannelTurnSource): boolean {
    return (
      source.chatType === "channel" &&
      isNonEmptyString(source.messageId) &&
      (!isNonEmptyString(source.threadId) ||
        source.threadId === source.messageId)
    );
  }

  function clearSlackStatusKeepalive(key: string): void {
    const timer = statusKeepaliveByAgentConversation.get(key);
    if (timer) {
      clearTimeout(timer);
      statusKeepaliveByAgentConversation.delete(key);
    }
  }

  async function writeSlackAssistantStatus(
    source: ChannelTurnSource,
    footerText: string,
    loadingText: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const stateKey = getAgentConversationSlackKey(source);
    const replyKey = getLifecycleReplyKey(source);
    const threadTs = resolveSlackProgressThreadTs(source);
    if (!stateKey || !replyKey || !threadTs) {
      return false;
    }

    const signature = `${footerText}\n${loadingText}`;
    if (
      options.force !== true &&
      statusSignatureByAgentConversation.get(stateKey) === signature
    ) {
      return true;
    }

    await ensureApp();
    const slackClient = await ensureWriteClient();
    const setStatus = slackClient.assistant?.threads?.setStatus;
    if (!setStatus) {
      return false;
    }

    statusSignatureByAgentConversation.set(stateKey, signature);
    const previousWrite =
      statusWritePromiseByAgentConversation.get(stateKey) ?? Promise.resolve();
    const operation = previousWrite.then(async () => {
      try {
        await setStatus.call(slackClient.assistant?.threads, {
          channel_id: source.chatId,
          thread_ts: threadTs,
          status: footerText,
          ...(footerText ? { loading_messages: [loadingText] } : {}),
        });
        if (footerText) {
          clearedStaleAssistantStatusReplyKeys.delete(replyKey);
        } else {
          clearedStaleAssistantStatusReplyKeys.add(replyKey);
        }
        return true;
      } catch (error) {
        if (statusSignatureByAgentConversation.get(stateKey) === signature) {
          statusSignatureByAgentConversation.delete(stateKey);
        }
        console.warn(
          "[Slack] Failed to update assistant thread status:",
          error instanceof Error ? error.message : error,
        );
        return false;
      }
    });
    const settled = operation.then(() => undefined);
    statusWritePromiseByAgentConversation.set(stateKey, settled);
    void settled.then(() => {
      if (statusWritePromiseByAgentConversation.get(stateKey) === settled) {
        statusWritePromiseByAgentConversation.delete(stateKey);
      }
    });
    return operation;
  }

  function scheduleSlackStatusKeepalive(key: string): void {
    clearSlackStatusKeepalive(key);
    const timer = setTimeout(() => {
      statusKeepaliveByAgentConversation.delete(key);
      void (async () => {
        const state = slackStateByAgentConversation.get(key);
        const source = statusSourceByAgentConversation.get(key);
        if (!state?.isThinkingActive || !source) {
          return;
        }
        await writeSlackAssistantStatus(
          source,
          state.typingFooterText,
          state.thinkingText,
          { force: true },
        );
        if (state.isThinkingActive) {
          scheduleSlackStatusKeepalive(key);
        }
      })();
    }, SLACK_ASSISTANT_STATUS_KEEPALIVE_MS);
    timer.unref?.();
    statusKeepaliveByAgentConversation.set(key, timer);
  }

  async function activateSlackStatus(
    source: ChannelTurnSource,
    footerText: string,
    loadingText: string,
  ): Promise<void> {
    const key = getAgentConversationSlackKey(source);
    if (!key || !getLifecycleReplyKey(source)) {
      return;
    }

    const state = slackStateByAgentConversation.get(key) ?? {
      isThinkingActive: false,
      thinkingText: "",
      typingFooterText: "",
    };
    if (
      state.isThinkingActive &&
      state.thinkingText === loadingText &&
      state.typingFooterText === footerText
    ) {
      statusSourceByAgentConversation.set(key, source);
      return;
    }

    state.isThinkingActive = true;
    state.thinkingText = loadingText;
    state.typingFooterText = footerText;
    slackStateByAgentConversation.set(key, state);
    statusSourceByAgentConversation.set(key, source);

    const sent = await writeSlackAssistantStatus(
      source,
      footerText,
      loadingText,
    );
    if (sent && state.isThinkingActive) {
      scheduleSlackStatusKeepalive(key);
    } else if (!sent) {
      state.isThinkingActive = false;
    }
  }

  function markSlackStatusAutoClearedByKey(key: string): void {
    clearSlackStatusKeepalive(key);
    const state = slackStateByAgentConversation.get(key);
    if (state) {
      state.isThinkingActive = false;
    }
    statusSignatureByAgentConversation.delete(key);
    statusSourceByAgentConversation.delete(key);
  }

  function markSlackStatusAutoCleared(source: ChannelTurnSource): void {
    const key = getAgentConversationSlackKey(source);
    if (key) {
      markSlackStatusAutoClearedByKey(key);
    }
  }

  function markSlackStatusAutoClearedForMessage(
    msg: Pick<
      OutboundChannelMessage,
      "agentId" | "conversationId" | "chatId" | "threadId" | "replyToMessageId"
    >,
  ): void {
    if (isNonEmptyString(msg.agentId) && isNonEmptyString(msg.conversationId)) {
      markSlackStatusAutoClearedByKey(`${msg.agentId}:${msg.conversationId}`);
      return;
    }

    const anchor = firstNonEmptyString(msg.threadId, msg.replyToMessageId);
    if (!anchor) {
      return;
    }
    const root = knownThreadIdsByMessageId.get(anchor) ?? anchor;
    for (const [key, source] of statusSourceByAgentConversation) {
      const sourceThread = resolveSlackProgressThreadTs(source);
      if (source.chatId === msg.chatId && sourceThread === root) {
        markSlackStatusAutoClearedByKey(key);
      }
    }
  }

  async function deactivateSlackStatus(
    source: ChannelTurnSource,
  ): Promise<void> {
    const key = getAgentConversationSlackKey(source);
    if (!key) {
      return;
    }
    clearSlackStatusKeepalive(key);
    const state = slackStateByAgentConversation.get(key);
    if (state) {
      state.isThinkingActive = false;
    }
    statusSignatureByAgentConversation.delete(key);
    statusSourceByAgentConversation.delete(key);
    await writeSlackAssistantStatus(source, "", "", { force: true });
    statusSignatureByAgentConversation.delete(key);
    slackStateByAgentConversation.delete(key);
  }

  async function clearStaleSlackStatus(
    source: ChannelTurnSource,
  ): Promise<void> {
    const key = getAgentConversationSlackKey(source);
    const replyKey = getLifecycleReplyKey(source);
    if (!key || !replyKey) {
      return;
    }
    if (
      slackStateByAgentConversation.get(key)?.isThinkingActive ||
      clearedStaleAssistantStatusReplyKeys.has(replyKey)
    ) {
      return;
    }
    await writeSlackAssistantStatus(source, "", "", { force: true });
    statusSignatureByAgentConversation.delete(key);
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

    const handleApprovalAction = async ({
      body,
      action,
      ack,
    }: {
      body: unknown;
      action: unknown;
      ack: () => Promise<void>;
    }) => {
      await ack();
      const actionRecord = getSlackActionRecord(action, body);
      const payload = parseSlackApprovalActionPayload(actionRecord?.value);
      const user = resolveSlackActionUser(body);
      if (!payload || !user.id || !adapter.onControlResponse) {
        return;
      }
      const prompt = approvalPromptByRequestId.get(payload.requestId);
      const clickedChannelId = resolveSlackActionChannelId(body);
      const clickedMessageTs = resolveSlackActionMessageId(body);
      const responseChatId = clickedChannelId ?? prompt?.source.chatId;
      if (!responseChatId) {
        return;
      }

      const result = await adapter.onControlResponse({
        requestId: payload.requestId,
        senderId: user.id,
        channel: "slack",
        accountId: config.accountId,
        chatId: responseChatId,
        threadId:
          resolveSlackActionThreadId(body) ?? prompt?.source.threadId ?? null,
        response: {
          request_id: payload.requestId,
          decision:
            payload.decision === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny", message: "Denied in Slack." },
        },
      });
      if (result === "unavailable" || result === "forbidden") {
        return;
      }

      const text =
        result === "expired"
          ? "Approval is no longer available."
          : payload.decision === "allow"
            ? `Approved by <@${user.id}>.`
            : `Denied by <@${user.id}>.`;
      const updateTargets = new Map<
        string,
        { channel: string; messageTs: string }
      >();
      if (prompt) {
        updateTargets.set(`${prompt.source.chatId}:${prompt.messageTs}`, {
          channel: prompt.source.chatId,
          messageTs: prompt.messageTs,
        });
      }
      if (clickedMessageTs) {
        updateTargets.set(`${responseChatId}:${clickedMessageTs}`, {
          channel: responseChatId,
          messageTs: clickedMessageTs,
        });
      }
      try {
        const slackClient = await ensureWriteClient();
        await Promise.all(
          Array.from(updateTargets.values()).map((target) =>
            slackClient.chat.update({
              channel: target.channel,
              ts: target.messageTs,
              text,
              blocks: buildSlackApprovalDecisionBlocks(text),
            }),
          ),
        );
        approvalPromptByRequestId.delete(payload.requestId);
      } catch (error) {
        console.warn(
          "[Slack] Failed to update approval prompt:",
          error instanceof Error ? error.message : error,
        );
      }
    };
    actionRegistrar.action?.(SLACK_APPROVAL_ACTION_ID, handleApprovalAction);

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
    // Memoize the in-flight creation: concurrent first callers (e.g. per-source
    // Promise.all clears at turn boundaries) must share one client instead of
    // racing past the null check and constructing duplicates.
    writeClientPromise ??= createSlackWebApiClient<SlackWriteClient>(
      config.botToken,
      {
        retryConfig: {
          retries: 0,
        },
      },
    ).then((client) => {
      writeClient = client;
      return client;
    });
    try {
      return await writeClientPromise;
    } catch (error) {
      writeClientPromise = null;
      throw error;
    }
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
      await Promise.all(
        getUniqueSlackStatusSources(
          Array.from(statusSourceByAgentConversation.values()),
        ).map((source) => deactivateSlackStatus(source)),
      );
      await app.stop();
      running = false;
      app = null;
      writeClient = null;
      writeClientPromise = null;
      botUserId = null;
      seenIngressMessageKeys.clear();
      for (const timer of statusKeepaliveByAgentConversation.values()) {
        clearTimeout(timer);
      }
      slackStateByAgentConversation.clear();
      statusSourceByAgentConversation.clear();
      statusSignatureByAgentConversation.clear();
      statusWritePromiseByAgentConversation.clear();
      statusKeepaliveByAgentConversation.clear();
      approvalPromptByRequestId.clear();
      clearedStaleAssistantStatusReplyKeys.clear();
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
        if (
          isSlackFlatChannelThreadOpener(event.source) &&
          isNonEmptyString(event.source.messageId) &&
          !agentThreadTracker.has(event.source.chatId, event.source.messageId)
        ) {
          await activateSlackStatus(
            event.source,
            SLACK_ASSISTANT_STARTUP_STATUS,
            SLACK_ASSISTANT_STARTUP_STATUS,
          );
        }
        return;
      }

      const sources = getUniqueSlackStatusSources(event.sources);
      if (event.type === "processing") {
        await Promise.all(
          sources.map((source) => clearStaleSlackStatus(source)),
        );
        return;
      }

      if (event.stopReason === "requires_approval") {
        return;
      }

      await Promise.all(sources.map((source) => deactivateSlackStatus(source)));
      if (!shouldPostSlackTerminalError(event.stopReason)) {
        return;
      }

      const errorText = event.error?.trim() ?? "";
      trackBoundaryError({
        context: "slack channel turn",
        errorType: "slack_channel_turn_error",
        error: errorText || event.stopReason,
        runId: event.runId ?? undefined,
      });

      const uniqueReplySources = new Map<string, ChannelTurnSource>();
      for (const source of sources) {
        const key = getLifecycleErrorReplyKey(source);
        if (key && !uniqueReplySources.has(key)) {
          uniqueReplySources.set(key, source);
        }
      }
      await Promise.all(
        Array.from(uniqueReplySources.values()).map(async (source) => {
          try {
            await sendLifecycleErrorReply(source, errorText);
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
      const activity = resolveSlackConcreteActivity(event);
      if (!activity) {
        return;
      }

      await Promise.all(
        getUniqueSlackStatusSources(event.sources).map((source) =>
          activateSlackStatus(source, SLACK_ASSISTANT_WORKING_STATUS, activity),
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
        markSlackStatusAutoClearedForMessage(msg);
        return result;
      }

      const threadTs = resolveSlackOutboundThreadTs({
        chatId: msg.chatId,
        threadId: msg.threadId,
        replyToMessageId: msg.replyToMessageId,
      });

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

      markSlackStatusAutoClearedForMessage(msg);

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

      markSlackStatusAutoClearedForMessage({
        chatId,
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
        event.kind === "generic_tool_approval" &&
        isNonEmptyString(response.ts)
      ) {
        approvalPromptByRequestId.set(event.requestId, {
          source: event.source,
          messageTs: response.ts,
        });
      }

      if (
        resolveSlackChatType(event.source.chatId) === "channel" &&
        isNonEmptyString(outboundThreadId)
      ) {
        agentThreadTracker.remember(event.source.chatId, outboundThreadId);
      }
      markSlackStatusAutoCleared(event.source);
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
    onControlResponse: undefined,
  };

  return adapter;
}
