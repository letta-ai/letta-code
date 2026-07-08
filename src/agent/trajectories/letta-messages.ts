// Letta conversation messages (as returned by the conversations/messages list
// API) → normalized-v1. Runs through the same row pipeline as every harness
// source, so a recorded agent conversation is byte-compatible with normalized
// session transcripts (same truncation caps, timestamp handling, and record
// shapes). Unlike a live wire stream, listed messages are complete — no delta
// coalescing needed, and the user prompt is present as a user_message.

import type { PseudoRow, SessionContext } from "./normalize-core";
import { normalizeSessionRows, parseTimestamp } from "./normalize-core";
import type { NormalizedRecord } from "./types";

interface LettaMessageLike {
  message_type?: string;
  date?: string | Date;
  content?: unknown;
  reasoning?: unknown;
  tool_call?: { name?: string; tool_call_id?: string; arguments?: string };
  tool_calls?: Array<{
    name?: string;
    tool_call_id?: string;
    arguments?: string;
  }>;
  tool_call_id?: string;
  tool_return?: unknown;
  status?: string;
  model?: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: string; text?: string } =>
          typeof part === "object" && part !== null,
      )
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function messageDate(message: LettaMessageLike): Date | null {
  if (message.date instanceof Date) return message.date;
  return parseTimestamp(
    typeof message.date === "string" ? message.date : undefined,
  );
}

function rowsForMessage(message: LettaMessageLike): PseudoRow[] {
  const timestamp = messageDate(message);
  switch (message.message_type) {
    case "user_message": {
      const content = textFromContent(message.content);
      return content
        ? [{ role: "user", turnType: "user_prompt", content, timestamp }]
        : [];
    }
    case "reasoning_message": {
      const content =
        typeof message.reasoning === "string"
          ? message.reasoning
          : textFromContent(message.reasoning);
      return content
        ? [
            {
              role: "assistant",
              turnType: "assistant_thinking",
              content,
              timestamp,
              model: message.model,
            },
          ]
        : [];
    }
    case "assistant_message": {
      const content = textFromContent(message.content);
      return content
        ? [
            {
              role: "assistant",
              turnType: "assistant_response",
              content,
              timestamp,
              model: message.model,
            },
          ]
        : [];
    }
    // Listed conversations represent tool calls as approval_request_message
    // (the approval flow records the call); live streams use
    // tool_call_message. Both carry the same tool_call payload.
    case "approval_request_message":
    case "tool_call_message": {
      const calls = message.tool_calls?.length
        ? message.tool_calls
        : message.tool_call
          ? [message.tool_call]
          : [];
      return calls
        .filter((call) => call.tool_call_id)
        .map((call) => ({
          role: "tool_use" as const,
          turnType: "tool_use" as const,
          timestamp,
          toolName: call.name,
          toolCallId: call.tool_call_id,
          toolInputJson: call.arguments || "{}",
          model: message.model,
        }));
    }
    case "tool_return_message": {
      if (!message.tool_call_id) return [];
      const text =
        typeof message.tool_return === "string"
          ? message.tool_return
          : textFromContent(message.tool_return);
      const content =
        message.status === "error" && !/^error/i.test(text)
          ? `Error: ${text}`
          : text;
      return [
        {
          role: "tool_result",
          turnType: "tool_result",
          content,
          timestamp,
          toolCallId: message.tool_call_id,
        },
      ];
    }
    default:
      return []; // system/hidden/usage/etc. carry no conversational content
  }
}

/**
 * Convert listed conversation messages (oldest first) into normalized-v1
 * records. Returns null when the messages contain no conversational content.
 */
export function normalizeLettaMessages(
  messages: unknown[],
  context?: Partial<SessionContext>,
): NormalizedRecord[] | null {
  const rows: PseudoRow[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    rows.push(...rowsForMessage(message as LettaMessageLike));
  }
  if (rows.length === 0) return null;
  const result = normalizeSessionRows(rows, {
    source: "letta-code",
    ...context,
  });
  return result.status === "ok" ? (result.records ?? null) : null;
}
