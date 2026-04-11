/**
 * MessageChannel tool — sends messages to external channels.
 *
 * Uses parentScope (injected per-execution by manager.ts executeTool())
 * for agent+conversation authorization. Does NOT use global context
 * singleton, which is unsafe in the listener's multi-runtime model.
 */

import { getChannelRegistry } from "../../channels/registry";
import type {
  ChannelRoute,
  OutboundChannelMessage,
} from "../../channels/types";

const TELEGRAM_CHANNEL_ID = "telegram";
const TELEGRAM_PLACEHOLDER_PREFIX = "LCTELEGRAMHTMLPLACEHOLDER";
const TELEGRAM_PLACEHOLDER_SUFFIX = "X";
const TELEGRAM_PLACEHOLDER_PATTERN = /LCTELEGRAMHTMLPLACEHOLDER(\d+)X/g;

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

export function formatOutboundChannelMessage(
  channel: string,
  text: string,
): Pick<OutboundChannelMessage, "text" | "parseMode"> {
  if (channel !== TELEGRAM_CHANNEL_ID) {
    return { text };
  }

  return {
    text: markdownToTelegramHtml(text),
    parseMode: "HTML",
  };
}

interface MessageChannelArgs {
  channel: string;
  chat_id: string;
  text: string;
  reply_to_message_id?: string;
  /** Injected by executeTool() — NOT read from global context. */
  parentScope?: { agentId: string; conversationId: string };
}

export async function message_channel(
  args: MessageChannelArgs,
): Promise<string> {
  const registry = getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized. Start with --channels flag.";
  }

  const adapter = registry.getAdapter(args.channel);
  if (!adapter) {
    return `Error: Channel "${args.channel}" is not configured or not running.`;
  }

  if (!adapter.isRunning()) {
    return `Error: Channel "${args.channel}" is not currently running.`;
  }

  // Per-agent+conversation authorization via injected scope.
  // parentScope comes from executeTool() options in manager.ts,
  // NOT the global context singleton (agent/context.ts).
  const scope = args.parentScope;
  if (!scope) {
    return "Error: MessageChannel requires execution scope (agentId + conversationId).";
  }

  const route: ChannelRoute | null = registry.getRoute(
    args.channel,
    args.chat_id,
  );
  if (
    !route ||
    route.agentId !== scope.agentId ||
    route.conversationId !== scope.conversationId
  ) {
    return `Error: No route for chat_id "${args.chat_id}" on "${args.channel}" for this agent/conversation.`;
  }

  try {
    const formattedMessage = formatOutboundChannelMessage(
      args.channel,
      args.text,
    );

    const result = await adapter.sendMessage({
      channel: args.channel,
      chatId: args.chat_id,
      text: formattedMessage.text,
      replyToMessageId: args.reply_to_message_id,
      parseMode: formattedMessage.parseMode,
    });

    return `Message sent to ${args.channel} (message_id: ${result.messageId})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return `Error sending message to ${args.channel}: ${msg}`;
  }
}
