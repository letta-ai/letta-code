import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { SKILL_CONTENT_BLOCK_REGEX } from "@/constants";
import { stripNonScheduledSystemReminders } from "@/cron/scheduled-task-prompt";

const PAGE_SIZE = 100;

export interface ParentTranscript {
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

export function serializeHistoryRecord(record: unknown): string {
  return JSON.stringify(record)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

export async function fetchParentConversationMessages(params: {
  backend: Pick<Backend, "listConversationMessages">;
  agentId: string;
  conversationId: string;
  signal?: AbortSignal;
  inContextIds?: string[];
  maxChars?: number;
}): Promise<Message[]> {
  const contextIds = params.inContextIds && new Set(params.inContextIds);
  const oldestId = params.inContextIds?.[0];
  if (contextIds?.size === 0 || (params.maxChars ?? 1) <= 0) return [];
  const messages: Message[] = [];
  let after: string | undefined;
  for (let pageIndex = 0; pageIndex < (contextIds ? 10 : 1); pageIndex++) {
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
    const boundary = items.findIndex((message) => message.id === oldestId);
    const withinBoundary = boundary >= 0 ? items.slice(0, boundary + 1) : items;
    messages.push(
      ...withinBoundary.filter(
        (message) =>
          (!contextIds || contextIds.has(message.id)) &&
          message.message_type !== "summary_message",
      ),
    );
    const preview = previewParentTranscript(
      renderParentTranscript([...messages].reverse()).messages,
    ).join("\n");
    if (
      boundary >= 0 ||
      items.length < PAGE_SIZE ||
      preview.length >= (params.maxChars ?? Infinity)
    )
      break;
    const cursor = items.at(-1)?.id;
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
  for (const match of text.matchAll(SKILL_CONTENT_BLOCK_REGEX)) {
    human(text.slice(end, match.index));
    events.push({
      type: "injected",
      kind: "skill",
      name: match[2]?.match(/\bname="([^"]*)"/)?.[1],
      text: match[3],
    });
    end = match.index + match[0].length;
  }
  human(text.slice(end));
  return events;
}

function renderMessage(message: Message): HistoryEvent[] {
  switch (message.message_type) {
    case "user_message": {
      const text = stripNonScheduledSystemReminders(
        contentText(message.content),
      ).trim();
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
      return [];
  }
}

export function renderParentTranscript(messages: Message[]): ParentTranscript {
  const blocks: string[] = [];
  const projections = new Map<string, string>();
  for (const message of messages) {
    for (const event of renderMessage(message)) {
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

export function previewParentTranscript(messages: string[]): string[] {
  return messages.map((line) => {
    const event = JSON.parse(line) as HistoryEvent & {
      seq: number;
      truncated?: boolean;
    };
    if (event.type === "summary") return line;
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
    }
    return serializeHistoryRecord(event);
  });
}

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
