/**
 * Shared MessageChannel tool — sends messages to external channels.
 *
 * Uses parentScope (injected per-execution by manager.ts executeTool())
 * for agent+conversation authorization. Does NOT use global context
 * singleton, which is unsafe in the listener's multi-runtime model.
 *
 * The public tool surface is intentionally shared across channels.
 * Channel plugins own action discovery and dispatch underneath it via
 * plugin.messageActions, following the OpenClaw-style architecture.
 */

import {
  isSupportedChannelId,
  loadChannelPlugin,
} from "../../channels/pluginRegistry";
import type {
  ChannelMessageActionName,
  ChannelMessageActionRequest,
} from "../../channels/pluginTypes";
import { getChannelRegistry } from "../../channels/registry";
import type {
  ChannelRoute,
  OutboundChannelMessage,
} from "../../channels/types";

const TELEGRAM_CHANNEL_ID = "telegram";
const TELEGRAM_PLACEHOLDER_PREFIX = "LCTELEGRAMHTMLPLACEHOLDER";
const TELEGRAM_PLACEHOLDER_SUFFIX = "X";
const TELEGRAM_PLACEHOLDER_PATTERN = /LCTELEGRAMHTMLPLACEHOLDER(\d+)X/g;
const SLACK_PLACEHOLDER_PREFIX = "LCSLACKMRKDWNPLACEHOLDER";
const SLACK_PLACEHOLDER_SUFFIX = "X";
const SLACK_PLACEHOLDER_PATTERN = /LCSLACKMRKDWNPLACEHOLDER(\d+)X/g;
const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

type OutboundChannelFormatter = (
  text: string,
) => Pick<OutboundChannelMessage, "text" | "parseMode">;

function decodeBasicXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
  return escapeTelegramHtml(text)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createTelegramPlaceholder(
  placeholders: string[],
  value: string,
): string {
  const placeholder = `${TELEGRAM_PLACEHOLDER_PREFIX}${placeholders.length}${TELEGRAM_PLACEHOLDER_SUFFIX}`;
  placeholders.push(value);
  return placeholder;
}

function restoreTelegramPlaceholders(
  text: string,
  placeholders: string[],
): string {
  return text.replace(TELEGRAM_PLACEHOLDER_PATTERN, (_match, index) => {
    return placeholders[Number(index)] ?? "";
  });
}

function createSlackPlaceholder(placeholders: string[], value: string): string {
  const placeholder = `${SLACK_PLACEHOLDER_PREFIX}${placeholders.length}${SLACK_PLACEHOLDER_SUFFIX}`;
  placeholders.push(value);
  return placeholder;
}

function restoreSlackPlaceholders(
  text: string,
  placeholders: string[],
): string {
  return text.replace(SLACK_PLACEHOLDER_PATTERN, (_match, index) => {
    return placeholders[Number(index)] ?? "";
  });
}

function replaceFencedCodeBlocks(text: string, placeholders: string[]): string {
  return text.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, _lang, code) => {
      return createTelegramPlaceholder(
        placeholders,
        `<pre>${escapeTelegramHtml(String(code).trimEnd())}</pre>`,
      );
    },
  );
}

function replaceInlineCode(text: string, placeholders: string[]): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code) => {
    return createTelegramPlaceholder(
      placeholders,
      `<code>${escapeTelegramHtml(String(code))}</code>`,
    );
  });
}

type ParsedMarkdownLink = {
  label: string;
  url: string;
  endIndex: number;
};

function parseMarkdownLink(
  text: string,
  startIndex: number,
): ParsedMarkdownLink | null {
  if (text[startIndex] !== "[") {
    return null;
  }

  let labelEnd = startIndex + 1;
  let bracketDepth = 1;
  while (labelEnd < text.length) {
    const char = text[labelEnd];
    if (char === "\\") {
      labelEnd += 2;
      continue;
    }
    if (char === "[") {
      bracketDepth++;
    } else if (char === "]") {
      bracketDepth--;
      if (bracketDepth === 0) {
        break;
      }
    }
    labelEnd++;
  }

  if (bracketDepth !== 0 || text[labelEnd + 1] !== "(") {
    return null;
  }

  let urlEnd = labelEnd + 2;
  let parenDepth = 1;
  while (urlEnd < text.length) {
    const char = text[urlEnd];
    if (char === "\\") {
      urlEnd += 2;
      continue;
    }
    if (char === "(") {
      parenDepth++;
    } else if (char === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        break;
      }
    }
    urlEnd++;
  }

  if (parenDepth !== 0) {
    return null;
  }

  const label = text.slice(startIndex + 1, labelEnd);
  const url = text.slice(labelEnd + 2, urlEnd).trim();
  if (!url) {
    return null;
  }

  return {
    label,
    url,
    endIndex: urlEnd + 1,
  };
}

function replaceMarkdownLinks(
  text: string,
  placeholders: string[],
  renderLabel: (label: string) => string,
): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "[") {
      result += text[index];
      index++;
      continue;
    }

    const link = parseMarkdownLink(text, index);
    if (!link) {
      result += text[index];
      index++;
      continue;
    }

    result += createTelegramPlaceholder(
      placeholders,
      `<a href="${escapeTelegramHtmlAttribute(link.url)}">${renderLabel(link.label)}</a>`,
    );
    index = link.endIndex;
  }

  return result;
}

function applyTelegramInlineFormatting(text: string): string {
  return text
    .replace(/\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/___([^\s_](?:[\s\S]*?[^\s_])?)___/g, "<b><i>$1</i></b>")
    .replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, "<b>$1</b>")
    .replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, "<b>$1</b>")
    .replace(/~~([^\s~](?:[\s\S]*?[^\s~])?)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*([^\s*](?:[\s\S]*?[^\s*])?)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/(^|[^\w_])_([^\s_](?:[\s\S]*?[^\s_])?)_(?!\w)/g, "$1<i>$2</i>");
}

function formatTelegramText(
  text: string,
  options?: { enableLinks?: boolean },
): string {
  const placeholders: string[] = [];
  let result = replaceFencedCodeBlocks(text, placeholders);
  result = replaceInlineCode(result, placeholders);

  if (options?.enableLinks !== false) {
    result = replaceMarkdownLinks(result, placeholders, (label) =>
      formatTelegramText(label, { enableLinks: false }),
    );
  }

  result = escapeTelegramHtml(result);
  result = applyTelegramInlineFormatting(result);

  return restoreTelegramPlaceholders(result, placeholders);
}

export function markdownToTelegramHtml(text: string): string {
  return formatTelegramText(text);
}

function escapeSlackMrkdwnSegment(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function escapeSlackMrkdwnContent(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(
      isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token),
    );
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

function replaceSlackFencedCodeBlocks(
  text: string,
  placeholders: string[],
): string {
  return text.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, _lang, code) => {
      const normalized = String(code).trimEnd();
      return createSlackPlaceholder(
        placeholders,
        normalized.length > 0 ? `\`\`\`\n${normalized}\n\`\`\`` : "```\n```",
      );
    },
  );
}

function replaceSlackInlineCode(text: string, placeholders: string[]): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code) => {
    return createSlackPlaceholder(placeholders, `\`${String(code)}\``);
  });
}

function applySlackInlineFormatting(text: string): string {
  return text
    .replace(/~~([^\s~](?:[\s\S]*?[^\s~])?)~~/g, "~$1~")
    .replace(/(^|[^\w*])\*([^\s*](?:[\s\S]*?[^\s*])?)\*(?!\w)/g, "$1_$2_")
    .replace(/\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/g, "_*$1*_")
    .replace(/___([^\s_](?:[\s\S]*?[^\s_])?)___/g, "_*$1*_")
    .replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, "*$1*")
    .replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, "*$1*");
}

function formatSlackLinkLabel(text: string): string {
  return applySlackInlineFormatting(escapeSlackMrkdwnText(text));
}

function replaceSlackMarkdownLinks(
  text: string,
  placeholders: string[],
): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "[") {
      result += text[index];
      index++;
      continue;
    }

    const link = parseMarkdownLink(text, index);
    if (!link) {
      result += text[index];
      index++;
      continue;
    }

    result += createSlackPlaceholder(
      placeholders,
      `<${escapeSlackMrkdwnSegment(link.url)}|${formatSlackLinkLabel(link.label)}>`,
    );
    index = link.endIndex;
  }

  return result;
}

function normalizeSlackBlockFormatting(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
      if (headingMatch) {
        return `*${headingMatch[1]?.trim() ?? ""}*`;
      }

      const bulletMatch = line.match(/^(\s*)[-+*]\s+(.+)$/);
      if (bulletMatch) {
        return `${bulletMatch[1] ?? ""}• ${bulletMatch[2] ?? ""}`;
      }

      return line;
    })
    .join("\n");
}

function formatSlackText(
  text: string,
  options?: { enableLinks?: boolean },
): string {
  const placeholders: string[] = [];
  let result = replaceSlackFencedCodeBlocks(text, placeholders);
  result = replaceSlackInlineCode(result, placeholders);

  if (options?.enableLinks !== false) {
    result = replaceSlackMarkdownLinks(result, placeholders);
  }

  result = escapeSlackMrkdwnText(result);
  result = applySlackInlineFormatting(result);
  result = normalizeSlackBlockFormatting(result);

  return restoreSlackPlaceholders(result, placeholders);
}

export function markdownToSlackMrkdwn(text: string): string {
  return formatSlackText(text);
}

const CHANNEL_OUTBOUND_FORMATTERS: Partial<
  Record<string, OutboundChannelFormatter>
> = {
  [TELEGRAM_CHANNEL_ID](text) {
    return {
      text: markdownToTelegramHtml(text),
      parseMode: "HTML",
    };
  },
  slack(text) {
    return {
      text: markdownToSlackMrkdwn(text),
    };
  },
};

export function formatOutboundChannelMessage(
  channel: string,
  text: string,
): Pick<OutboundChannelMessage, "text" | "parseMode"> {
  const normalizedText = decodeBasicXmlEntities(text);
  const formatter = CHANNEL_OUTBOUND_FORMATTERS[channel];
  if (!formatter) {
    return { text: normalizedText };
  }
  return formatter(normalizedText);
}

interface MessageChannelArgs {
  channel: string;
  action: string;
  chat_id: string;
  message?: string;
  replyTo?: string;
  threadId?: string;
  messageId?: string;
  emoji?: string;
  remove?: boolean;
  media?: string;
  filename?: string;
  title?: string;
  /** Injected by executeTool() — NOT read from global context. */
  parentScope?: { agentId: string; conversationId: string };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function firstDefinedBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function normalizeChatTarget(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 2 && /^[a-z_-]+$/i.test(parts[0] ?? "")) {
    return parts[1] ?? trimmed;
  }
  if (
    parts.length === 3 &&
    /^[a-z_-]+$/i.test(parts[0] ?? "") &&
    /^[a-z_-]+$/i.test(parts[1] ?? "")
  ) {
    return parts[2] ?? trimmed;
  }
  return trimmed;
}

function normalizeMessageAction(
  rawAction: string,
): ChannelMessageActionName | null {
  const normalized = rawAction.trim().toLowerCase();

  switch (normalized) {
    case "send":
      return "send";
    case "react":
      return "react";
    case "upload-file":
      return "upload-file";
    default:
      return null;
  }
}

function normalizeMessageChannelRequest(
  args: MessageChannelArgs,
): ChannelMessageActionRequest | string {
  const channel = firstNonEmptyString(args.channel)?.toLowerCase();
  if (!channel) {
    return "Error: MessageChannel requires channel.";
  }
  if (!isSupportedChannelId(channel)) {
    return `Error: Unsupported channel "${channel}".`;
  }

  const rawAction = firstNonEmptyString(args.action);
  if (!rawAction) {
    return "Error: MessageChannel requires action.";
  }

  const action = normalizeMessageAction(rawAction);
  if (!action) {
    return `Error: Unsupported MessageChannel action "${args.action}".`;
  }

  const rawChatId = firstNonEmptyString(args.chat_id);
  if (!rawChatId) {
    return "Error: MessageChannel requires chat_id.";
  }

  return {
    action,
    channel,
    chatId: normalizeChatTarget(rawChatId),
    message: firstNonEmptyString(args.message),
    replyToMessageId: firstNonEmptyString(args.replyTo),
    threadId: firstNonEmptyString(args.threadId) ?? null,
    messageId: firstNonEmptyString(args.messageId),
    emoji: firstNonEmptyString(args.emoji),
    remove: firstDefinedBoolean(args.remove),
    mediaPath: firstNonEmptyString(args.media),
    filename: firstNonEmptyString(args.filename),
    title: firstNonEmptyString(args.title),
  };
}

export async function message_channel(
  args: MessageChannelArgs,
): Promise<string> {
  const registry = getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized. Start with --channels flag.";
  }

  // Per-agent+conversation authorization via injected scope.
  // parentScope comes from executeTool() options in manager.ts,
  // NOT the global context singleton (agent/context.ts).
  const scope = args.parentScope;
  if (!scope) {
    return "Error: MessageChannel requires execution scope (agentId + conversationId).";
  }

  const request = normalizeMessageChannelRequest(args);
  if (typeof request === "string") {
    return request;
  }

  const route: ChannelRoute | null = registry.getRouteForScope(
    request.channel,
    request.chatId,
    scope.agentId,
    scope.conversationId,
  );
  if (!route) {
    return `Error: No route for chat_id "${request.chatId}" on "${request.channel}" for this agent/conversation.`;
  }

  const adapter = registry.getAdapter(request.channel, route.accountId);
  if (!adapter) {
    return `Error: Channel "${request.channel}" is not configured or not running.`;
  }

  if (!adapter.isRunning()) {
    return `Error: Channel "${request.channel}" is not currently running.`;
  }

  try {
    const plugin = await loadChannelPlugin(request.channel);
    if (!plugin.messageActions) {
      return `Error: Channel "${request.channel}" does not expose MessageChannel actions.`;
    }

    const discovery = plugin.messageActions.describeMessageTool({
      accountId: route.accountId ?? null,
    });
    const supportedActions = new Set<string>(["send"]);
    for (const action of discovery.actions ?? []) {
      supportedActions.add(action);
    }
    if (!supportedActions.has(request.action)) {
      return `Error: Action "${request.action}" is not supported on ${request.channel}.`;
    }

    return await plugin.messageActions.handleAction({
      request,
      route,
      adapter,
      formatText: (text) => formatOutboundChannelMessage(request.channel, text),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return `Error sending message to ${request.channel}: ${msg}`;
  }
}
