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
} from "@/channels/plugin-registry";
import type {
  ChannelMessageActionName,
  ChannelMessageActionRequest,
} from "@/channels/plugin-types";
import { getChannelRegistry } from "@/channels/registry";
import { resolveEligibleProactiveSlackAccount } from "@/channels/slack/proactive-accounts";
import type {
  ChannelAdapter,
  ChannelRoute,
  ChannelTurnSource,
  OutboundChannelMessage,
  SupportedChannelId,
} from "@/channels/types";

const TELEGRAM_CHANNEL_ID = "telegram";
const SIGNAL_CHANNEL_ID = "signal";
const TELEGRAM_PLACEHOLDER_PREFIX = "LCTELEGRAMHTMLPLACEHOLDER";
const TELEGRAM_PLACEHOLDER_SUFFIX = "X";
const TELEGRAM_PLACEHOLDER_PATTERN = /LCTELEGRAMHTMLPLACEHOLDER(\d+)X/g;
const SLACK_PLACEHOLDER_PREFIX = "LCSLACKMRKDWNPLACEHOLDER";
const SLACK_PLACEHOLDER_SUFFIX = "X";
const SLACK_PLACEHOLDER_PATTERN = /LCSLACKMRKDWNPLACEHOLDER(\d+)X/g;
const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

type OutboundChannelFormatter = (
  text: string,
) => Pick<OutboundChannelMessage, "text" | "parseMode" | "textStyle">;

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

function replaceTelegramBlockQuotes(
  text: string,
  placeholders: string[],
): string {
  const lines = text.split("\n");
  const formattedLines: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const quoteMatch = lines[index]?.match(/^ {0,3}> ?(.*)$/);
    if (!quoteMatch) {
      formattedLines.push(lines[index] ?? "");
      continue;
    }

    const quoteLines: string[] = [quoteMatch[1] ?? ""];
    while (index + 1 < lines.length) {
      const nextMatch = lines[index + 1]?.match(/^ {0,3}> ?(.*)$/);
      if (!nextMatch) {
        break;
      }
      quoteLines.push(nextMatch[1] ?? "");
      index++;
    }

    formattedLines.push(
      createTelegramPlaceholder(
        placeholders,
        `<blockquote>${formatTelegramText(quoteLines.join("\n"), {
          enableBlockQuotes: false,
        })}</blockquote>`,
      ),
    );
  }

  return formattedLines.join("\n");
}

function formatTelegramText(
  text: string,
  options?: { enableBlockQuotes?: boolean; enableLinks?: boolean },
): string {
  const placeholders: string[] = [];
  let result = replaceFencedCodeBlocks(text, placeholders);
  result = replaceInlineCode(result, placeholders);

  if (options?.enableLinks !== false) {
    result = replaceMarkdownLinks(result, placeholders, (label) =>
      formatTelegramText(label, {
        enableBlockQuotes: false,
        enableLinks: false,
      }),
    );
  }

  if (options?.enableBlockQuotes !== false) {
    result = replaceTelegramBlockQuotes(result, placeholders);
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
        return `${bulletMatch[1] ?? ""}- ${bulletMatch[2] ?? ""}`;
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

type SignalMarkdownStyle =
  | "BOLD"
  | "ITALIC"
  | "SPOILER"
  | "STRIKETHROUGH"
  | "MONOSPACE";

type SignalMarkdownRange = {
  start: number;
  length: number;
  style: SignalMarkdownStyle;
};

type SignalMarkdownState = {
  text: string;
  ranges: SignalMarkdownRange[];
};

type SignalInlineMarker = {
  delimiter: string;
  styles: SignalMarkdownStyle[];
  requireWordBoundary?: boolean;
};

const SIGNAL_INLINE_MARKERS: SignalInlineMarker[] = [
  { delimiter: "***", styles: ["BOLD", "ITALIC"] },
  { delimiter: "___", styles: ["BOLD", "ITALIC"] },
  { delimiter: "**", styles: ["BOLD"] },
  { delimiter: "__", styles: ["BOLD"] },
  { delimiter: "~~", styles: ["STRIKETHROUGH"] },
  { delimiter: "||", styles: ["SPOILER"] },
  { delimiter: "*", styles: ["ITALIC"], requireWordBoundary: true },
  { delimiter: "_", styles: ["ITALIC"], requireWordBoundary: true },
];

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function isWordLike(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

function addSignalStyle(
  state: SignalMarkdownState,
  start: number,
  style: SignalMarkdownStyle,
): void {
  const length = state.text.length - start;
  if (length <= 0) {
    return;
  }
  state.ranges.push({ start, length, style });
}

function canOpenSignalMarker(
  text: string,
  index: number,
  marker: SignalInlineMarker,
): boolean {
  const next = text[index + marker.delimiter.length];
  if (!next || /\s/.test(next)) {
    return false;
  }
  if (!marker.requireWordBoundary) {
    return true;
  }
  const previous = text[index - 1];
  return !isWordLike(previous);
}

function isValidSignalMarkerContent(
  text: string,
  closeIndex: number,
  content: string,
  marker: SignalInlineMarker,
): boolean {
  if (content.length === 0 || /^\s|\s$/.test(content)) {
    return false;
  }
  if (!marker.requireWordBoundary) {
    return true;
  }
  const next = text[closeIndex + marker.delimiter.length];
  return !isWordLike(next);
}

function findSignalClosingMarker(
  text: string,
  contentStart: number,
  marker: SignalInlineMarker,
): number {
  let searchIndex = contentStart;
  while (searchIndex < text.length) {
    const closeIndex = text.indexOf(marker.delimiter, searchIndex);
    if (closeIndex < 0) {
      return -1;
    }
    if (isEscaped(text, closeIndex)) {
      searchIndex = closeIndex + marker.delimiter.length;
      continue;
    }
    const content = text.slice(contentStart, closeIndex);
    if (isValidSignalMarkerContent(text, closeIndex, content, marker)) {
      return closeIndex;
    }
    searchIndex = closeIndex + marker.delimiter.length;
  }
  return -1;
}

function parseSignalInline(text: string, state: SignalMarkdownState): void {
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && index + 1 < text.length) {
      state.text += text[index + 1] ?? "";
      index += 2;
      continue;
    }

    if (text[index] === "`") {
      const closeIndex = text.indexOf("`", index + 1);
      if (
        closeIndex > index + 1 &&
        !text.slice(index + 1, closeIndex).includes("\n")
      ) {
        const start = state.text.length;
        state.text += text.slice(index + 1, closeIndex);
        addSignalStyle(state, start, "MONOSPACE");
        index = closeIndex + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const link = parseMarkdownLink(text, index);
      if (link) {
        parseSignalInline(link.label, state);
        state.text += ` (${link.url})`;
        index = link.endIndex;
        continue;
      }
    }

    const marker = SIGNAL_INLINE_MARKERS.find(
      (candidate) =>
        text.startsWith(candidate.delimiter, index) &&
        !isEscaped(text, index) &&
        canOpenSignalMarker(text, index, candidate),
    );
    if (marker) {
      const contentStart = index + marker.delimiter.length;
      const closeIndex = findSignalClosingMarker(text, contentStart, marker);
      if (closeIndex >= 0) {
        const start = state.text.length;
        parseSignalInline(text.slice(contentStart, closeIndex), state);
        for (const style of marker.styles) {
          addSignalStyle(state, start, style);
        }
        index = closeIndex + marker.delimiter.length;
        continue;
      }
    }

    state.text += text[index] ?? "";
    index++;
  }
}

function parseSignalMarkdownLine(
  line: string,
  state: SignalMarkdownState,
): void {
  const lineStyles: SignalMarkdownStyle[] = [];
  let content = line;

  const headingMatch = content.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (headingMatch) {
    content = headingMatch[1]?.trim() ?? "";
    lineStyles.push("BOLD");
  } else {
    const quoteMatch = content.match(/^\s{0,3}> ?(.*)$/);
    if (quoteMatch) {
      content = quoteMatch[1] ?? "";
      lineStyles.push("ITALIC");
    } else {
      const bulletMatch = content.match(/^(\s*)[+*]\s+(.+)$/);
      if (bulletMatch) {
        content = `${bulletMatch[1] ?? ""}- ${bulletMatch[2] ?? ""}`;
      }
    }
  }

  const start = state.text.length;
  parseSignalInline(content, state);
  for (const style of lineStyles) {
    addSignalStyle(state, start, style);
  }
}

function flushSignalCodeBlock(
  state: SignalMarkdownState,
  lines: string[],
): void {
  const code = lines.join("\n").trimEnd();
  if (code.length === 0) {
    return;
  }
  const start = state.text.length;
  state.text += code;
  addSignalStyle(state, start, "MONOSPACE");
}

function signalTextStyleToString(range: SignalMarkdownRange): string {
  return `${range.start}:${range.length}:${range.style}`;
}

export function markdownToSignalTextStyles(
  text: string,
): Pick<OutboundChannelMessage, "text" | "textStyle"> {
  const state: SignalMarkdownState = { text: "", ranges: [] };
  const lines = text.split("\n");
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const isLastLine = index === lines.length - 1;

    if (inCodeBlock) {
      if (/^\s{0,3}```\s*$/.test(line)) {
        flushSignalCodeBlock(state, codeBlockLines);
        codeBlockLines = [];
        inCodeBlock = false;
        if (!isLastLine) {
          state.text += "\n";
        }
      } else {
        codeBlockLines.push(line);
      }
      continue;
    }

    if (/^\s{0,3}```[^`]*$/.test(line)) {
      inCodeBlock = true;
      codeBlockLines = [];
      continue;
    }

    parseSignalMarkdownLine(line, state);
    if (!isLastLine) {
      state.text += "\n";
    }
  }

  if (inCodeBlock) {
    flushSignalCodeBlock(state, codeBlockLines);
  }

  const seenStyles = new Set<string>();
  const textStyle = state.ranges
    .map(signalTextStyleToString)
    .filter((style) => {
      if (seenStyles.has(style)) {
        return false;
      }
      seenStyles.add(style);
      return true;
    });
  return {
    text: state.text,
    ...(textStyle.length > 0 ? { textStyle } : {}),
  };
}

const CHANNEL_OUTBOUND_FORMATTERS: Partial<
  Record<string, OutboundChannelFormatter>
> = {
  [SIGNAL_CHANNEL_ID](text) {
    return markdownToSignalTextStyles(text);
  },
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
): Pick<OutboundChannelMessage, "text" | "parseMode" | "textStyle"> {
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
  chat_id?: string;
  target?: string;
  accountId?: string;
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
  /** Injected by executeTool() for channel-originated turns. */
  channelTurnSources?: ChannelTurnSource[];
}

interface NormalizedMessageChannelInput {
  channel: SupportedChannelId;
  action: ChannelMessageActionName;
  chatId?: string;
  target?: string;
  accountId?: string;
  message?: string;
  replyToMessageId?: string;
  threadId?: string | null;
  messageId?: string;
  emoji?: string;
  remove?: boolean;
  mediaPath?: string;
  filename?: string;
  title?: string;
}

interface ResolvedMessageChannelExecutionContext {
  request: ChannelMessageActionRequest;
  route: ChannelRoute;
  adapter: ChannelAdapter;
  plugin: Awaited<ReturnType<typeof loadChannelPlugin>>;
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

function normalizeChatTarget(
  channel: SupportedChannelId,
  value: string,
): string {
  const trimmed = value.trim();
  if (channel === "signal") {
    return trimmed;
  }
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
  return normalized.length > 0 ? normalized : null;
}

function normalizeMessageChannelInput(
  args: MessageChannelArgs,
): NormalizedMessageChannelInput | string {
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
  const rawTarget = firstNonEmptyString(args.target);
  if (!rawChatId && !rawTarget) {
    return "Error: MessageChannel requires exactly one of chat_id or target.";
  }
  if (rawChatId && rawTarget) {
    return "Error: MessageChannel requires exactly one of chat_id or target.";
  }

  return {
    action,
    channel,
    ...(rawChatId ? { chatId: normalizeChatTarget(channel, rawChatId) } : {}),
    ...(rawTarget ? { target: rawTarget } : {}),
    accountId: firstNonEmptyString(args.accountId),
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

function buildMessageChannelRequest(
  input: NormalizedMessageChannelInput,
  chatId: string,
  threadId?: string | null,
): ChannelMessageActionRequest {
  return {
    action: input.action,
    channel: input.channel,
    chatId,
    message: input.message,
    replyToMessageId: input.replyToMessageId,
    threadId: threadId ?? input.threadId ?? null,
    messageId: input.messageId,
    emoji: input.emoji,
    remove: input.remove,
    mediaPath: input.mediaPath,
    filename: input.filename,
    title: input.title,
  };
}

function buildSyntheticChannelRoute(params: {
  scope: { agentId: string; conversationId: string };
  accountId: string;
  chatId: string;
  chatType?: ChannelRoute["chatType"];
  threadId?: string | null;
}): ChannelRoute {
  const now = new Date().toISOString();
  return {
    accountId: params.accountId,
    chatId: params.chatId,
    chatType: params.chatType,
    threadId: params.threadId ?? null,
    agentId: params.scope.agentId,
    conversationId: params.scope.conversationId,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function inferAccountIdFromChannelTurnSources(params: {
  input: NormalizedMessageChannelInput;
  scope: { agentId: string; conversationId: string };
  channelTurnSources?: ChannelTurnSource[];
}): string | undefined {
  const chatId = params.input.chatId;
  if (!chatId) {
    return undefined;
  }

  const accountIds = new Set<string>();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.input.channel ||
      source.chatId !== chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId
    ) {
      continue;
    }
    if (
      params.input.threadId !== undefined &&
      (source.threadId ?? null) !== (params.input.threadId ?? null)
    ) {
      continue;
    }
    if (source.accountId?.trim()) {
      accountIds.add(source.accountId.trim());
    }
  }

  return accountIds.size === 1 ? [...accountIds][0] : undefined;
}

function inferThreadIdFromChannelTurnSources(params: {
  input: NormalizedMessageChannelInput;
  scope: { agentId: string; conversationId: string };
  accountId?: string;
  channelTurnSources?: ChannelTurnSource[];
}): string | null | undefined {
  if (!params.input.chatId || params.input.threadId !== null) {
    return undefined;
  }

  const threadIds = new Set<string | null>();
  for (const source of params.channelTurnSources ?? []) {
    if (
      source.channel !== params.input.channel ||
      source.chatId !== params.input.chatId ||
      source.agentId !== params.scope.agentId ||
      source.conversationId !== params.scope.conversationId
    ) {
      continue;
    }
    if (params.accountId && source.accountId !== params.accountId) {
      continue;
    }

    const sourceThreadId =
      source.chatType === "direct" ? null : (source.threadId ?? null);
    const fallbackThreadId =
      params.input.channel === "slack" && source.chatType !== "direct"
        ? source.messageId
        : null;
    threadIds.add(sourceThreadId ?? fallbackThreadId ?? null);
  }

  return threadIds.size === 1 ? [...threadIds][0] : undefined;
}

async function resolveExplicitMessageChannelContext(params: {
  input: NormalizedMessageChannelInput;
  scope: { agentId: string; conversationId: string };
}): Promise<ResolvedMessageChannelExecutionContext | string> {
  if (params.input.channel !== "slack") {
    return `Error: Explicit MessageChannel targets are not supported on ${params.input.channel}.`;
  }

  const eligibleAccount = resolveEligibleProactiveSlackAccount({
    agentId: params.scope.agentId,
    conversationId: params.scope.conversationId,
    accountId: params.input.accountId,
  });
  if (typeof eligibleAccount === "string") {
    return eligibleAccount;
  }

  const plugin = await loadChannelPlugin("slack");
  const resolver = plugin.messageActions?.resolveMessageTarget;
  if (!resolver) {
    return "Error: Explicit MessageChannel targets are not supported on slack.";
  }

  const resolvedTarget = await resolver({
    account: eligibleAccount.account,
    target: params.input.target ?? "",
  });

  return {
    request: buildMessageChannelRequest(
      params.input,
      resolvedTarget.chatId,
      resolvedTarget.threadId,
    ),
    route: buildSyntheticChannelRoute({
      scope: params.scope,
      accountId: eligibleAccount.account.accountId,
      chatId: resolvedTarget.chatId,
      chatType: resolvedTarget.chatType,
      threadId: resolvedTarget.threadId,
    }),
    adapter: eligibleAccount.adapter,
    plugin,
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

  const input = normalizeMessageChannelInput(args);
  if (typeof input === "string") {
    return input;
  }

  try {
    let executionContext: ResolvedMessageChannelExecutionContext | string;
    if (input.chatId) {
      const resolvedAccountId =
        input.accountId ??
        inferAccountIdFromChannelTurnSources({
          input,
          scope,
          channelTurnSources: args.channelTurnSources,
        });
      const route: ChannelRoute | null = registry.getRouteForScope(
        input.channel,
        input.chatId,
        scope.agentId,
        scope.conversationId,
        resolvedAccountId,
      );
      if (!route) {
        return resolvedAccountId
          ? `Error: No route for chat_id "${input.chatId}" on "${input.channel}" account "${resolvedAccountId}" for this agent/conversation.`
          : `Error: No route for chat_id "${input.chatId}" on "${input.channel}" for this agent/conversation. If multiple channel accounts can receive this chat, pass accountId (from the channel notification's account_id) to disambiguate.`;
      }

      const adapter = registry.getAdapter(input.channel, route.accountId);
      if (!adapter) {
        return `Error: Channel "${input.channel}" is not configured or not running.`;
      }

      if (!adapter.isRunning()) {
        return `Error: Channel "${input.channel}" is not currently running.`;
      }

      const plugin = await loadChannelPlugin(input.channel);
      const inferredThreadId = inferThreadIdFromChannelTurnSources({
        input,
        scope,
        accountId: resolvedAccountId,
        channelTurnSources: args.channelTurnSources,
      });
      executionContext = {
        request: buildMessageChannelRequest(
          input,
          input.chatId,
          inferredThreadId ?? input.threadId,
        ),
        route,
        adapter,
        plugin,
      };
    } else {
      executionContext = await resolveExplicitMessageChannelContext({
        input,
        scope,
      });
    }

    if (typeof executionContext === "string") {
      return executionContext;
    }

    const { request, route, adapter, plugin } = executionContext;
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
    return `Error sending message to ${input.channel}: ${msg}`;
  }
}
