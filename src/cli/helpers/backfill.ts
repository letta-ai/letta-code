import type {
  ImageContent,
  LettaAssistantMessageContentUnion,
  LettaUserMessageContentUnion,
  Message,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import type { Buffers } from "./accumulator";

/**
 * Extract displayable text from tool return content.
 * Multimodal content returns the text parts concatenated.
 */
function getDisplayableToolReturn(
  content: string | Array<TextContent | ImageContent> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") {
    return content;
  }
  // Extract text from multimodal content
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const CLIP_CHAR_LIMIT_TEXT = 500;

function clip(s: string, limit: number): string {
  if (!s) return "";
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * Normalize line endings: convert \r\n and \r to \n
 */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Truncate system-reminder content while preserving opening/closing tags.
 * Removes the middle content and replaces with [...] to keep the message compact
 * but with proper tag structure.
 */
function truncateSystemReminder(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const openIdx = text.indexOf(SYSTEM_REMINDER_OPEN);
  const closeIdx = text.lastIndexOf(SYSTEM_REMINDER_CLOSE);

  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    // Malformed, just use regular clip
    return clip(text, maxLength);
  }

  const openEnd = openIdx + SYSTEM_REMINDER_OPEN.length;
  const ellipsis = "\n...\n";

  // Calculate available space for content (split between start and end)
  const overhead =
    SYSTEM_REMINDER_OPEN.length +
    SYSTEM_REMINDER_CLOSE.length +
    ellipsis.length;
  const availableContent = maxLength - overhead;
  if (availableContent <= 0) {
    // Not enough space, just show tags with ellipsis
    return `${SYSTEM_REMINDER_OPEN}${ellipsis}${SYSTEM_REMINDER_CLOSE}`;
  }

  const halfContent = Math.floor(availableContent / 2);
  const contentStart = text.slice(openEnd, openEnd + halfContent);
  const contentEnd = text.slice(closeIdx - halfContent, closeIdx);

  return `${SYSTEM_REMINDER_OPEN}${contentStart}${ellipsis}${contentEnd}${SYSTEM_REMINDER_CLOSE}`;
}

/**
 * Check if a user message is a compaction summary (system_alert with summary content).
 * Returns the summary text if found, null otherwise.
 */
export function extractCompactionSummary(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed.type === "system_alert" &&
      typeof parsed.message === "string" &&
      parsed.message.includes("prior messages have been hidden")
    ) {
      // Extract the summary part after the header
      const summaryMatch = parsed.message.match(
        /The following is a summary of the previous messages:\s*([\s\S]*)/,
      );
      if (summaryMatch?.[1]) {
        return summaryMatch[1].trim();
      }
      return parsed.message;
    }
  } catch {
    // Not JSON, not a compaction summary
  }
  return null;
}

function renderAssistantContentParts(
  parts: string | LettaAssistantMessageContentUnion[],
): string {
  // AssistantContent can be a string or an array of text parts
  if (typeof parts === "string") return parts;
  let out = "";
  for (const p of parts) {
    if (p.type === "text") {
      out += p.text || "";
    }
  }
  return out;
}

/**
 * Check if text is purely a system-reminder block (no user content before/after).
 */
function isOnlySystemReminder(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(SYSTEM_REMINDER_OPEN) &&
    trimmed.endsWith(SYSTEM_REMINDER_CLOSE)
  );
}

function renderUserContentParts(
  parts: string | LettaUserMessageContentUnion[],
): string {
  // UserContent can be a string or an array of text OR image parts
  // Pure system-reminder parts are truncated (middle) to preserve tags
  // Mixed content or user text uses simple end truncation
  // Parts are joined with newlines so each appears as a separate line
  if (typeof parts === "string") return parts;

  const rendered: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      const text = p.text || "";
      // Normalize line endings (\r\n and \r -> \n) to prevent terminal garbling
      const normalized = normalizeLineEndings(text);
      if (isOnlySystemReminder(normalized)) {
        // Pure system-reminder: truncate middle to preserve tags
        rendered.push(truncateSystemReminder(normalized, CLIP_CHAR_LIMIT_TEXT));
      } else {
        // User content or mixed: simple end truncation
        rendered.push(clip(normalized, CLIP_CHAR_LIMIT_TEXT));
      }
    } else if (p.type === "image") {
      rendered.push("[Image]");
    }
  }
  // Join with double-newline so each part starts a new paragraph (gets "> " prefix)
  return rendered.join("\n\n");
}

export function backfillBuffers(buffers: Buffers, history: Message[]): void {
  // Clear buffers to ensure idempotency (in case this is called multiple times)
  buffers.order = [];
  buffers.byId.clear();
  buffers.toolCallIdToLineId.clear();
  buffers.pendingToolByRun.clear();
  buffers.lastOtid = null;
  // Note: we don't reset tokenCount here (it resets per-turn in onSubmit)

  // Iterate over the history and add the messages to the buffers
  // Want to add user, reasoning, assistant, tool call + tool return
  for (const msg of history) {
    // Use otid as line ID when available (like streaming does), fall back to msg.id
    const lineId = "otid" in msg && msg.otid ? msg.otid : msg.id;

    switch (msg.message_type) {
      // user message - content parts may include text and image parts
      case "user_message": {
        const rawText = renderUserContentParts(msg.content);

        // Check if this is a compaction summary message (old format embedded in user_message)
        const compactionSummary = extractCompactionSummary(rawText);
        if (compactionSummary) {
          // Render as a finished compaction event
          const exists = buffers.byId.has(lineId);
          buffers.byId.set(lineId, {
            kind: "event",
            id: lineId,
            eventType: "compaction",
            eventData: {},
            phase: "finished",
            summary: compactionSummary,
          });
          if (!exists) buffers.order.push(lineId);
          break;
        }

        const exists = buffers.byId.has(lineId);
        buffers.byId.set(lineId, {
          kind: "user",
          id: lineId,
          text: rawText,
        });
        if (!exists) buffers.order.push(lineId);
        break;
      }

      // reasoning message -
      case "reasoning_message": {
        const exists = buffers.byId.has(lineId);
        buffers.byId.set(lineId, {
          kind: "reasoning",
          id: lineId,
          text: msg.reasoning,
          phase: "finished",
        });
        if (!exists) buffers.order.push(lineId);
        break;
      }

      // assistant message - content parts may include text and image parts
      case "assistant_message": {
        const exists = buffers.byId.has(lineId);
        buffers.byId.set(lineId, {
          kind: "assistant",
          id: lineId,
          text: renderAssistantContentParts(msg.content),
          phase: "finished",
        });
        if (!exists) buffers.order.push(lineId);
        break;
      }

      // tool call message OR approval request (they're the same in history)
      case "tool_call_message":
      case "approval_request_message": {
        // Use tool_calls array (new) or fallback to tool_call (deprecated)
        const toolCalls = Array.isArray(msg.tool_calls)
          ? msg.tool_calls
          : msg.tool_call
            ? [msg.tool_call]
            : [];

        // Process ALL tool calls (supports parallel tool calling)
        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i];
          if (!toolCall?.tool_call_id) continue;

          const toolCallId = toolCall.tool_call_id;
          // Skip if any required fields are missing
          if (!toolCallId || !toolCall.name || !toolCall.arguments) continue;

          // For parallel tool calls, create unique line ID for each
          // Must match the streaming logic: first tool uses base lineId,
          // subsequent tools append part of tool_call_id (not index!)
          let uniqueLineId = lineId;

          // Check if base lineId is already used by a tool_call
          if (buffers.byId.has(lineId)) {
            const existing = buffers.byId.get(lineId);
            if (existing && existing.kind === "tool_call") {
              // Another tool already used this line ID
              // Create unique ID using tool_call_id suffix (match streaming logic)
              uniqueLineId = `${lineId}-${toolCallId.slice(-8)}`;
            }
          }

          const exists = buffers.byId.has(uniqueLineId);

          buffers.byId.set(uniqueLineId, {
            kind: "tool_call",
            id: uniqueLineId,
            toolCallId: toolCallId,
            name: toolCall.name,
            argsText: toolCall.arguments,
            phase: "ready",
          });
          if (!exists) buffers.order.push(uniqueLineId);

          // Maintain mapping for tool return to find this line
          buffers.toolCallIdToLineId.set(toolCallId, uniqueLineId);
        }
        break;
      }

      // tool return message - merge into the existing tool call line(s)
      case "tool_return_message": {
        // Handle parallel tool returns: check tool_returns array first, fallback to singular fields
        const toolReturns =
          Array.isArray(msg.tool_returns) && msg.tool_returns.length > 0
            ? msg.tool_returns
            : msg.tool_call_id
              ? [
                  {
                    tool_call_id: msg.tool_call_id,
                    status: msg.status,
                    func_response: msg.tool_return,
                    stdout: msg.stdout,
                    stderr: msg.stderr,
                  },
                ]
              : [];

        for (const toolReturn of toolReturns) {
          const toolCallId = toolReturn.tool_call_id;
          if (!toolCallId) continue;

          // Look up the line using the mapping (like streaming does)
          const toolCallLineId = buffers.toolCallIdToLineId.get(toolCallId);
          if (!toolCallLineId) continue;

          const existingLine = buffers.byId.get(toolCallLineId);
          if (!existingLine || existingLine.kind !== "tool_call") continue;

          // Update the existing line with the result
          // Handle both func_response (streaming) and tool_return (SDK) properties
          // tool_return can be multimodal (string or array of content parts)
          const rawResult =
            ("func_response" in toolReturn
              ? toolReturn.func_response
              : undefined) ||
            ("tool_return" in toolReturn
              ? toolReturn.tool_return
              : undefined) ||
            "";
          const resultText = getDisplayableToolReturn(rawResult);
          buffers.byId.set(toolCallLineId, {
            ...existingLine,
            resultText,
            resultOk: toolReturn.status === "success",
            phase: "finished",
          });
        }
        break;
      }

      default: {
        // Handle new compaction message types (when include_compaction_messages=true)
        // These are not yet in the SDK types, so we handle them via string comparison
        const msgType = msg.message_type as string | undefined;

        if (msgType === "summary_message") {
          // SummaryMessage has: summary (str), compaction_stats (optional)
          const summaryMsg = msg as Message & {
            summary?: string;
            compaction_stats?: {
              trigger?: string;
              context_tokens_before?: number;
              context_tokens_after?: number;
              context_window?: number;
              messages_count_before?: number;
              messages_count_after?: number;
            };
          };

          const summaryText = summaryMsg.summary || "";
          const stats = summaryMsg.compaction_stats;

          // Find the most recent compaction event line and update it with summary and stats
          for (let i = buffers.order.length - 1; i >= 0; i--) {
            const orderId = buffers.order[i];
            if (!orderId) continue;
            const line = buffers.byId.get(orderId);
            if (line?.kind === "event" && line.eventType === "compaction") {
              line.phase = "finished";
              line.summary = summaryText;
              if (stats) {
                line.stats = {
                  trigger: stats.trigger,
                  contextTokensBefore: stats.context_tokens_before,
                  contextTokensAfter: stats.context_tokens_after,
                  contextWindow: stats.context_window,
                  messagesCountBefore: stats.messages_count_before,
                  messagesCountAfter: stats.messages_count_after,
                };
              }
              break;
            }
          }
          break;
        }

        if (msgType === "event_message") {
          // EventMessage has: event_type (str), event_data (dict)
          const eventMsg = msg as Message & {
            event_type?: string;
            event_data?: Record<string, unknown>;
          };

          const exists = buffers.byId.has(lineId);
          buffers.byId.set(lineId, {
            kind: "event",
            id: lineId,
            eventType: eventMsg.event_type || "unknown",
            eventData: eventMsg.event_data || {},
            phase: "finished", // In backfill, events are always finished (summary already processed)
          });
          if (!exists) buffers.order.push(lineId);
          break;
        }

        // ignore other message types
        break;
      }
    }
  }

  // Mark stray tool calls as closed
  // Walk backwards: any pending tool_call before the first "transition" (non-pending-tool-call) is stray
  let foundTransition = false;
  for (let i = buffers.order.length - 1; i >= 0; i--) {
    const lineId = buffers.order[i];
    if (!lineId) continue;
    const line = buffers.byId.get(lineId);

    if (line?.kind === "tool_call" && line.phase === "ready") {
      if (foundTransition) {
        // This is a stray - mark it closed
        buffers.byId.set(lineId, {
          ...line,
          phase: "finished",
          resultText: "[Tool return not found in history]",
          resultOk: false,
        });
      }
      // else: legit pending, leave it
    } else {
      // Hit something that's not a pending tool_call - transition point
      foundTransition = true;
    }
  }
}
