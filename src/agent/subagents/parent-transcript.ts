/**
 * Render a parent conversation as a readable transcript for workers that
 * cannot share Letta's conversation state (claude-code, codex, cursor, ...).
 *
 * Letta subagents fork the conversation server-side. External workers get the
 * same history as Markdown instead: user and assistant turns, tool calls with
 * their arguments, and tool results clipped to a fixed size. Reasoning,
 * system messages, and `<system-reminder>` blocks are omitted.
 */

import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { STARTUP_CONTEXT_ESTIMATED_CHARS_PER_TOKEN } from "./context-budget";

/** Per tool result; long outputs are rarely needed verbatim to follow a task. */
export const PARENT_TRANSCRIPT_TOOL_RESULT_CHARS = 2_000;
/** Per tool call's JSON arguments (file writes can carry whole files). */
export const PARENT_TRANSCRIPT_TOOL_ARGS_CHARS = 4_000;
/** Most recent turns to consider for the inline tail. */
export const PARENT_TRANSCRIPT_INLINE_TURNS = 4;

const PAGE_SIZE = 100;
const SYSTEM_REMINDER_PATTERN =
  /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

export interface ParentTranscript {
  /** One Markdown block per turn; a turn starts at each user message. */
  turns: string[];
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

function clip(text: string, limit: number, what: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${what} truncated: ${(text.length - limit).toLocaleString()} more characters]`;
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
  return `**Tool call: ${call.name || "unknown"}**\n${fence(
    clip(args, PARENT_TRANSCRIPT_TOOL_ARGS_CHARS, "arguments"),
    "json",
  )}`;
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
  return `**Tool result${status}**\n${fence(
    clip(text || "(empty)", PARENT_TRANSCRIPT_TOOL_RESULT_CHARS, "result"),
  )}`;
}

/** Render one message, or null when it carries nothing a worker should see. */
function renderMessage(message: Message): {
  block: string;
  startsTurn: boolean;
} | null {
  switch (message.message_type) {
    case "user_message": {
      const text = contentText(message.content)
        .replace(SYSTEM_REMINDER_PATTERN, "")
        .trim();
      return text ? { block: `### User\n\n${text}`, startsTurn: true } : null;
    }
    case "assistant_message": {
      const text = contentText(message.content).trim();
      return text
        ? { block: `### Assistant\n\n${text}`, startsTurn: false }
        : null;
    }
    case "tool_call_message":
    case "approval_request_message": {
      const calls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [message.tool_call];
      const blocks = calls.filter(Boolean).map(renderToolCall);
      return blocks.length
        ? { block: blocks.join("\n\n"), startsTurn: false }
        : null;
    }
    case "tool_return_message": {
      const results = message.tool_returns?.length
        ? message.tool_returns
        : [message];
      return {
        block: results.map(renderToolResult).join("\n\n"),
        startsTurn: false,
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
      return blocks.length
        ? { block: blocks.join("\n\n"), startsTurn: false }
        : null;
    }
    case "summary_message":
      return {
        block: `### Summary of earlier conversation\n\n${message.summary}`,
        startsTurn: true,
      };
    default:
      // reasoning, hidden reasoning, system, and compaction events
      return null;
  }
}

export function renderParentTranscript(messages: Message[]): ParentTranscript {
  const turns: string[] = [];
  let current: string[] = [];
  for (const message of messages) {
    const rendered = renderMessage(message);
    if (!rendered) continue;
    if (rendered.startsTurn && current.length) {
      turns.push(current.join("\n\n"));
      current = [];
    }
    current.push(rendered.block);
  }
  if (current.length) turns.push(current.join("\n\n"));
  return {
    turns,
    markdown: `# Parent conversation transcript\n\n${turns.join("\n\n---\n\n")}\n`,
  };
}

/**
 * The most recent turns that fit in `maxChars`, oldest first. When even the
 * last turn is too large, keep its end, where the latest request usually is.
 */
export function selectRecentTurns(
  turns: string[],
  maxChars: number,
  maxTurns = PARENT_TRANSCRIPT_INLINE_TURNS,
): { text: string; turnCount: number } {
  const selected: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0 && selected.length < maxTurns; i--) {
    const turn = turns[i] as string;
    const cost = turn.length + (selected.length ? 7 : 0);
    if (used + cost > maxChars) {
      if (selected.length === 0) {
        const marker = "… [start of this turn omitted]\n";
        selected.unshift(
          marker +
            turn.slice(turn.length - Math.max(0, maxChars - marker.length)),
        );
      }
      break;
    }
    selected.unshift(turn);
    used += cost;
  }
  return { text: selected.join("\n\n---\n\n"), turnCount: selected.length };
}

export function estimateTranscriptTokens(markdown: string): number {
  return Math.ceil(markdown.length / STARTUP_CONTEXT_ESTIMATED_CHARS_PER_TOKEN);
}
