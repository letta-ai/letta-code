/**
 * Render a parent conversation as a readable transcript for workers that
 * cannot share Letta's conversation state (claude-code, codex, cursor, ...).
 *
 * Letta subagents fork the conversation server-side. External workers get the
 * history as JSONL instead: user and assistant messages, tool calls with
 * their arguments, and tool results. Reasoning,
 * system messages, and `<system-reminder>` blocks are omitted.
 */

import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";

const PAGE_SIZE = 100;
/** Ten API pages bound external worker startup independently of parent age. */
export const PARENT_HISTORY_MESSAGE_LIMIT = 1_000;
const SYSTEM_REMINDER_PATTERN =
  /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

export interface ParentTranscript {
  /** One JSON record per supported event, in chronological order. */
  messages: string[];
  jsonl: string;
}

interface HistoryEvent {
  type:
    | "message"
    | "injected"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "summary";
  role?: "user" | "assistant";
  speaker?: string;
  kind?: "skill";
  name?: string;
  call_id?: string;
  arguments?: string;
  text?: string;
  status?: string;
}

/** JSON escapes keep historical text from closing the surrounding prompt tags. */
export function serializeHistoryRecord(record: unknown): string {
  return JSON.stringify(record)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/** Fetch a bounded recent tail and return it in chronological order. */
export async function fetchParentConversationMessages(params: {
  backend: Pick<Backend, "listConversationMessages">;
  agentId: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<Message[]> {
  const messages: Message[] = [];
  let after: string | undefined;
  for (;;) {
    params.signal?.throwIfAborted();
    const page = await params.backend.listConversationMessages(
      params.conversationId,
      {
        agent_id: params.agentId,
        order: "desc",
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    const items = page.getPaginatedItems();
    messages.push(...items);
    if (
      items.length < PAGE_SIZE ||
      messages.length >= PARENT_HISTORY_MESSAGE_LIMIT
    )
      break;
    const cursor = items[items.length - 1]?.id;
    // A page whose cursor cannot advance would otherwise be fetched forever.
    if (!cursor || cursor === after) break;
    after = cursor;
  }
  return messages.reverse();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ("text" in part && typeof part.text === "string") return part.text;
      if ("type" in part && part.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderToolCall(call: {
  name?: string | null;
  arguments?: string | null;
  tool_call_id?: string | null;
}): HistoryEvent {
  return {
    type: "tool_call",
    call_id: call.tool_call_id ?? undefined,
    name: call.name || "unknown",
    arguments: call.arguments || "{}",
  };
}

function renderToolResult(result: {
  status?: string | null;
  tool_return?: unknown;
  func_response?: unknown;
  tool_call_id?: string | null;
}): HistoryEvent {
  const raw = result.tool_return ?? result.func_response;
  const text =
    typeof raw === "string"
      ? raw
      : contentText(raw) || (raw == null ? "" : JSON.stringify(raw));
  return {
    type: "tool_result",
    call_id: result.tool_call_id ?? undefined,
    status: result.status ?? undefined,
    text,
  };
}

/** Separate known harness wrappers without guessing provenance from prose. */
function userEvents(text: string, speaker?: string): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const human = (body: string) => {
    if (body.trim())
      events.push({
        type: "message",
        role: "user",
        speaker,
        text: body.trim(),
      });
  };
  let end = 0;
  for (const match of text.matchAll(
    /<skill_content\b([^>]*)>([\s\S]*?)<\/skill_content>/g,
  )) {
    human(text.slice(end, match.index));
    events.push({
      type: "injected",
      kind: "skill",
      name: match[1]?.match(/\bname="([^"]*)"/)?.[1],
      text: match[2],
    });
    end = match.index + match[0].length;
  }
  human(text.slice(end));
  return events;
}

function renderMessage(message: Message): HistoryEvent[] {
  switch (message.message_type) {
    case "user_message": {
      const text = contentText(message.content)
        .replace(SYSTEM_REMINDER_PATTERN, "")
        .trim();
      return userEvents(text, message.name ?? undefined);
    }
    case "assistant_message": {
      const text = contentText(message.content).trim();
      return text
        ? [
            {
              type: "message",
              role: "assistant",
              speaker: message.name ?? undefined,
              text,
            },
          ]
        : [];
    }
    case "tool_call_message":
    case "approval_request_message": {
      const calls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [message.tool_call];
      return calls.filter(Boolean).map(renderToolCall);
    }
    case "tool_return_message": {
      const results = message.tool_returns?.length
        ? message.tool_returns
        : [message];
      return results.map(renderToolResult);
    }
    case "approval_response_message": {
      // Client-side tools report their results through approval responses.
      return (message.approvals ?? []).map(
        (approval): HistoryEvent =>
          "tool_return" in approval
            ? renderToolResult(approval)
            : {
                type: "approval",
                call_id: approval.tool_call_id,
                status: approval.approve ? "approved" : "denied",
                text: approval.reason ?? undefined,
              },
      );
    }
    case "summary_message":
      return [{ type: "summary", text: message.summary }];
    default:
      // reasoning, hidden reasoning, system, and compaction events
      return [];
  }
}

export function renderParentTranscript(messages: Message[]): ParentTranscript {
  const blocks: string[] = [];
  const projections = new Map<string, string>();
  for (const message of messages) {
    for (const event of renderMessage(message)) {
      // Approval and tool rows can project the same execution. Preserve separate
      // calls with identical output, and conflicting results rather than hiding them.
      if (
        event.call_id &&
        (event.type === "tool_result" || event.type === "tool_call")
      ) {
        const key = serializeHistoryRecord([message.step_id, event]);
        const previous = projections.get(key);
        if (previous && previous !== message.message_type) continue;
        projections.set(key, message.message_type ?? "");
      }
      blocks.push(
        serializeHistoryRecord({
          seq: blocks.length + 1,
          message_id: message.id,
          ...event,
        }),
      );
    }
  }
  return {
    messages: blocks,
    jsonl: blocks.join("\n"),
  };
}

/** Bound individual preview records; the full JSONL keeps their exact content. */
export function previewParentTranscript(messages: string[]): string[] {
  return messages.map((line) => {
    const event = JSON.parse(line) as HistoryEvent & {
      seq: number;
      truncated?: boolean;
      content_ref?: { seq: number };
    };
    for (const field of ["text", "arguments"] as const) {
      const text = event[field];
      if (typeof text !== "string") continue;
      if (event.type === "injected") {
        delete event[field];
      } else if (text.length > 4_000) {
        event[field] =
          `${text.slice(0, 2_000)}\n[... omitted ...]\n${text.slice(-2_000)}`;
      } else continue;
      event.truncated = true;
      event.content_ref = { seq: event.seq };
    }
    return serializeHistoryRecord(event);
  });
}

/** Keep a complete suffix of messages inline; preserve the remainder in a file. */
export function selectRecentMessages(
  messages: string[],
  maxChars: number,
): { text: string; messageCount: number; earlier: string } {
  let used = 0;
  let start = messages.length;
  while (start > 0) {
    const cost = (messages[start - 1] as string).length + (used ? 1 : 0);
    if (used + cost > maxChars) break;
    start--;
    used += cost;
  }
  return {
    text: messages.slice(start).join("\n"),
    messageCount: messages.length - start,
    earlier: messages.slice(0, start).join("\n"),
  };
}
