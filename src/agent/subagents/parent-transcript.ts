/**
 * Render a parent conversation as a readable transcript for workers that
 * cannot share Letta's conversation state (claude-code, codex, cursor, ...).
 *
 * Letta subagents fork the conversation server-side. External workers get the
 * history as Markdown instead: user and assistant messages, tool calls with
 * their arguments, and tool results. Reasoning,
 * system messages, and `<system-reminder>` blocks are omitted.
 */

import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";

const PAGE_SIZE = 100;
const SYSTEM_REMINDER_PATTERN =
  /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

export interface ParentTranscript {
  /** One Markdown block per supported message, in chronological order. */
  messages: string[];
  /** Full Markdown document. */
  markdown: string;
}

/** Page through a conversation oldest-first, skipping reasoning and system rows. */
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
        order: "asc",
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    const items = page.getPaginatedItems();
    messages.push(...items);
    if (items.length < PAGE_SIZE) break;
    const cursor = items[items.length - 1]?.id;
    // A page whose cursor cannot advance would otherwise be fetched forever.
    if (!cursor || cursor === after) break;
    after = cursor;
  }
  return messages;
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

function fence(body: string, lang = ""): string {
  // Longer fences survive results that themselves contain ``` blocks.
  const longest = Math.max(
    2,
    ...Array.from(body.matchAll(/`{3,}/g), (m) => m[0].length),
  );
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function renderToolCall(call: {
  name?: string | null;
  arguments?: string | null;
}): string {
  const args = call.arguments?.trim() || "{}";
  return `**Tool call: ${call.name || "unknown"}**\n${fence(args, "json")}`;
}

function renderToolResult(result: {
  status?: string | null;
  tool_return?: unknown;
  func_response?: unknown;
}): string {
  const raw = result.tool_return ?? result.func_response;
  const text =
    typeof raw === "string"
      ? raw
      : contentText(raw) || (raw == null ? "" : JSON.stringify(raw));
  const status = result.status === "error" ? " (error)" : "";
  return `**Tool result${status}**\n${fence(text || "(empty)")}`;
}

/** Render one message, or null when it carries nothing a worker should see. */
function renderMessage(message: Message): {
  block: string;
} | null {
  switch (message.message_type) {
    case "user_message": {
      const text = contentText(message.content)
        .replace(SYSTEM_REMINDER_PATTERN, "")
        .trim();
      return text ? { block: `### User\n\n${text}` } : null;
    }
    case "assistant_message": {
      const text = contentText(message.content).trim();
      return text ? { block: `### Assistant\n\n${text}` } : null;
    }
    case "tool_call_message":
    case "approval_request_message": {
      const calls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [message.tool_call];
      const blocks = calls.filter(Boolean).map(renderToolCall);
      return blocks.length ? { block: blocks.join("\n\n") } : null;
    }
    case "tool_return_message": {
      const results = message.tool_returns?.length
        ? message.tool_returns
        : [message];
      return {
        block: results.map(renderToolResult).join("\n\n"),
      };
    }
    case "approval_response_message": {
      // Client-side tools report their results through approval responses.
      const blocks = (message.approvals ?? []).map((approval) =>
        "tool_return" in approval
          ? renderToolResult(approval)
          : `**Tool call ${approval.approve ? "approved" : "denied"}**${
              approval.reason ? `: ${approval.reason}` : ""
            }`,
      );
      return blocks.length ? { block: blocks.join("\n\n") } : null;
    }
    case "summary_message":
      return {
        block: `### Summary of earlier conversation\n\n${message.summary}`,
      };
    default:
      // reasoning, hidden reasoning, system, and compaction events
      return null;
  }
}

export function renderParentTranscript(messages: Message[]): ParentTranscript {
  const blocks: string[] = [];
  for (const message of messages) {
    const rendered = renderMessage(message);
    if (!rendered) continue;
    blocks.push(rendered.block);
  }
  return {
    messages: blocks,
    markdown: blocks.join("\n\n---\n\n"),
  };
}

/** Keep a complete suffix of messages inline; preserve the remainder in a file. */
export function selectRecentMessages(
  messages: string[],
  maxChars: number,
): { text: string; messageCount: number; earlier: string } {
  let used = 0;
  let start = messages.length;
  while (start > 0) {
    const cost = (messages[start - 1] as string).length + (used ? 7 : 0);
    if (used + cost > maxChars) break;
    start--;
    used += cost;
  }
  return {
    text: messages.slice(start).join("\n\n---\n\n"),
    messageCount: messages.length - start,
    earlier: messages.slice(0, start).join("\n\n---\n\n"),
  };
}
