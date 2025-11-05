import type {
  LettaAssistantMessageContentUnion,
  LettaMessageUnion,
  LettaUserMessageContentUnion,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Buffers } from "./accumulator";

// const PASTE_LINE_THRESHOLD = 5;
// const PASTE_CHAR_THRESHOLD = 500;
const CLIP_CHAR_LIMIT_TEXT = 500;
// const CLIP_CHAR_LIMIT_JSON = 1000;

// function countLines(text: string): number {
//   return (text.match(/\r\n|\r|\n/g) || []).length + 1;
// }

function clip(s: string, limit: number): string {
  if (!s) return "";
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
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

function renderUserContentParts(
  parts: string | LettaUserMessageContentUnion[],
): string {
  // UserContent can be a string or an array of text OR image parts
  // for text parts, we clip them if they're too big (eg copy-pasted chunks)
  // for image parts, we just show a placeholder
  if (typeof parts === "string") return parts;

  let out = "";
  for (const p of parts) {
    if (p.type === "text") {
      const text = p.text || "";
      out += clip(text, CLIP_CHAR_LIMIT_TEXT);
    } else if (p.type === "image") {
      out += `[Image]`;
    }
  }
  return out;
}

export function backfillBuffers(
  buffers: Buffers,
  history: LettaMessageUnion[],
): void {
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
        const exists = buffers.byId.has(lineId);
        buffers.byId.set(lineId, {
          kind: "user",
          id: lineId,
          text: renderUserContentParts(msg.content),
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

        if (toolCalls.length > 0 && toolCalls[0]?.tool_call_id) {
          const toolCall = toolCalls[0];
          const toolCallId = toolCall.tool_call_id;
          // Skip if any required fields are missing
          if (!toolCallId || !toolCall.name || !toolCall.arguments) break;

          const exists = buffers.byId.has(lineId);

          buffers.byId.set(lineId, {
            kind: "tool_call",
            id: lineId,
            toolCallId: toolCallId,
            name: toolCall.name,
            argsText: toolCall.arguments,
            phase: "ready",
          });
          if (!exists) buffers.order.push(lineId);

          // Maintain mapping for tool return to find this line
          buffers.toolCallIdToLineId.set(toolCallId, lineId);
        }
        break;
      }

      // tool return message - merge into the existing tool call line
      case "tool_return_message": {
        const toolCallId = msg.tool_call_id;
        if (!toolCallId) break;

        // Look up the line using the mapping (like streaming does)
        const toolCallLineId = buffers.toolCallIdToLineId.get(toolCallId);
        if (!toolCallLineId) break;

        const existingLine = buffers.byId.get(toolCallLineId);
        if (!existingLine || existingLine.kind !== "tool_call") break;

        // Update the existing line with the result
        buffers.byId.set(toolCallLineId, {
          ...existingLine,
          resultText: msg.tool_return,
          resultOk: msg.status === "success",
          phase: "finished",
        });
        break;
      }

      default:
        break; // ignore other message types
    }
  }
}
