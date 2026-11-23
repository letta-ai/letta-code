import { isRecord } from "@/utils/type-guards";
import type { LocalMessage } from "./local-message";

export const LOCAL_SUMMARY_TOOL_RETURN_TRUNCATION_CHARS = 2_000;

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateToolReturn(content: string, limit?: number): string {
  if (limit === undefined || content.length <= limit) return content;
  return `${content.slice(0, limit)}... [truncated ${content.length - limit} chars]`;
}

function middleTruncateText(
  text: string,
  budgetChars: number,
  headFrac = 0.3,
  tailFrac = 0.3,
): string {
  if (budgetChars <= 0 || text.length <= budgetChars) return text;
  const headLength = Math.max(0, Math.floor(budgetChars * headFrac));
  let tailLength = Math.max(0, Math.floor(budgetChars * tailFrac));
  if (headLength + tailLength > budgetChars) {
    tailLength = Math.max(0, budgetChars - headLength);
  }

  const head = text.slice(0, headLength);
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  const dropped = Math.max(0, text.length - (head.length + tail.length));
  const marker = `\n[TRUNCATED: dropped ${dropped} middle chars due to context budget]\n`;
  return `${head}${marker}${tail}`;
}

type SummaryOpenAIMessage = {
  role: "assistant" | "developer" | "system" | "tool" | "user";
  content?: string | null | Array<{ text?: string } | string>;
  tool_calls?: Array<{
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
};

function textFromUserContent(
  content: LocalMessage & { role: "user" },
): string | undefined {
  const value = content.content;
  if (typeof value === "string") return value || undefined;
  const textParts: string[] = [];
  let imageCount = 0;
  for (const part of value) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "image") imageCount += 1;
  }
  let textContent = textParts.join("\n\n");
  if (imageCount > 0) {
    const placeholder =
      imageCount === 1 ? "[Image omitted]" : `[${imageCount} images omitted]`;
    textContent = `${textContent}${textContent ? " " : ""}${placeholder}`;
  }
  return textContent || undefined;
}

function textFromAssistantContent(
  message: LocalMessage & { role: "assistant" },
): string | undefined {
  const textParts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }
    if (part.type === "thinking") {
      textParts.push(part.thinking);
    }
  }
  const textContent = textParts.join("\n\n");
  return textContent || undefined;
}

function localToolCallArguments(input: unknown): string {
  return typeof input === "string" ? input : stringifyUnknown(input ?? {});
}

function toolReturnToText(
  value: LocalMessage & { role: "toolResult" },
): string | undefined {
  const textParts: string[] = [];
  let imageCount = 0;
  for (const item of value.content) {
    if (item.type === "text") {
      textParts.push(item.text);
      continue;
    }
    if (item.type === "image") imageCount += 1;
  }
  let result = textParts.join("\n");
  if (imageCount > 0) {
    const placeholder =
      imageCount === 1 ? "[Image omitted]" : `[${imageCount} images omitted]`;
    result = `${result}${result ? " " : ""}${placeholder}`;
  }
  return result || undefined;
}

function localMessagesToSummaryOpenAIDicts(
  messages: LocalMessage[],
  options: { toolReturnTruncationChars?: number } = {},
): SummaryOpenAIMessage[] {
  const result: SummaryOpenAIMessage[] = [];
  for (const message of messages) {
    const compactionSummary = message.metadata?.compaction?.summary;
    if (typeof compactionSummary === "string") {
      result.push({ role: "user", content: compactionSummary });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.content.filter(
        (part) => part.type === "toolCall",
      );
      const content = textFromAssistantContent(message) ?? null;
      if (content !== null || toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((toolCall) => ({
                  function: {
                    name: toolCall.name,
                    arguments: localToolCallArguments(toolCall.arguments),
                  },
                })),
              }
            : {}),
        });
      }
      continue;
    }

    if (message.role === "toolResult") {
      const returnText = toolReturnToText(message);
      result.push({
        role: "tool",
        content: returnText
          ? truncateToolReturn(returnText, options.toolReturnTruncationChars)
          : null,
      });
      continue;
    }

    if (message.role === "user") {
      const content = textFromUserContent(message);
      if (content !== undefined) {
        result.push({ role: "user", content });
      }
    }
  }
  return result;
}

function simpleFormatter(messages: SummaryOpenAIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    try {
      const role = message.role ?? "?";
      let content: unknown = message.content;
      if (Array.isArray(content)) {
        content = content
          .map((block) =>
            isRecord(block) && typeof block.text === "string"
              ? block.text
              : String(block),
          )
          .join(" ");
      }
      let text = typeof content === "string" ? content : "";
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const callParts = message.tool_calls.map((toolCall) => {
          const fn = toolCall.function ?? {};
          return `${fn.name ?? "?"}(${fn.arguments ?? ""})`;
        });
        text = `${text}${text ? " " : ""}-> ${callParts.join(", ")}`;
      }
      if (text) lines.push(`[${role}] ${text}`);
    } catch {
      lines.push(JSON.stringify(message));
    }
  }

  return ` \n${lines.join("\n")}\n \n. Generate the summary.`;
}

export function formatLocalMessagesForSummary(
  messages: LocalMessage[],
  options: { truncationChars?: number; maxChars?: number } = {},
): string {
  const transcript = simpleFormatter(
    localMessagesToSummaryOpenAIDicts(messages, {
      toolReturnTruncationChars:
        options.truncationChars ?? LOCAL_SUMMARY_TOOL_RETURN_TRUNCATION_CHARS,
    }),
  );
  return options.maxChars
    ? middleTruncateText(transcript, options.maxChars)
    : transcript;
}
