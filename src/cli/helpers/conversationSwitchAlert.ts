import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";

const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 500;

export interface ConversationSwitchContext {
  origin:
    | "resume-direct"
    | "resume-selector"
    | "new"
    | "clear"
    | "search"
    | "agent-switch";
  conversationId: string;
  isDefault: boolean;

  summary?: string;
  messageCount?: number;
  messageHistory?: Message[];

  searchQuery?: string;
  searchMessage?: string;

  agentSwitchContext?: {
    name: string;
    description?: string;
    model: string;
    blockCount: number;
  };
}

export function buildConversationSwitchAlert(
  ctx: ConversationSwitchContext,
): string {
  const parts: string[] = [];

  if (ctx.origin === "new" || ctx.origin === "clear") {
    parts.push(
      "New conversation started. This is a fresh conversation thread with no prior messages.",
    );
    parts.push(`Conversation: ${ctx.conversationId}`);
  } else if (ctx.origin === "search") {
    parts.push(
      `Conversation switched. The user searched for "${ctx.searchQuery}" and jumped to this conversation based on a matching message.`,
    );
    if (ctx.searchMessage) {
      parts.push(`Selected message: "${ctx.searchMessage}"`);
    }
    pushConversationMeta(parts, ctx);
    pushMessageHistory(parts, ctx);
  } else if (ctx.origin === "agent-switch" && ctx.agentSwitchContext) {
    const a = ctx.agentSwitchContext;
    parts.push("Switched to a different agent.");
    parts.push(`Agent: ${a.name}`);
    if (a.description) {
      parts.push(`Description: ${a.description}`);
    }
    parts.push(
      `Model: ${a.model} · ${a.blockCount} memory block${a.blockCount === 1 ? "" : "s"}`,
    );
    pushMessageHistory(parts, ctx);
    parts.push(
      "The conversation context has changed entirely — review the in-context messages.",
    );
  } else if (ctx.isDefault) {
    parts.push(
      "Switched to the agent's default conversation (the primary, non-isolated message history).",
    );
    parts.push(
      "This conversation is shared across all sessions that don't use explicit conversation IDs.",
    );
    pushMessageHistory(parts, ctx);
    parts.push("Review the in-context messages for full conversation history.");
  } else {
    const via =
      ctx.origin === "resume-selector" ? "/resume selector" : "/resume";
    parts.push(`Conversation resumed via ${via}.`);
    pushConversationMeta(parts, ctx);
    pushMessageHistory(parts, ctx);
    parts.push("Review the in-context messages for full conversation history.");
  }

  return `${SYSTEM_REMINDER_OPEN}\n${parts.join("\n")}\n${SYSTEM_REMINDER_CLOSE}\n\n`;
}

function pushConversationMeta(
  parts: string[],
  ctx: ConversationSwitchContext,
): void {
  const label = ctx.isDefault ? "default" : ctx.conversationId;
  const countSuffix =
    ctx.messageCount != null ? ` (${ctx.messageCount} messages)` : "";
  parts.push(`Conversation: ${label}${countSuffix}`);
  if (ctx.summary) {
    parts.push(`Summary: ${ctx.summary}`);
  }
}

function extractMessageText(msg: Message): string | null {
  const content = (
    msg as Message & {
      content?: string | Array<{ type?: string; text?: string }>;
    }
  ).content;

  if (!content) return null;

  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (p): p is { type: string; text: string } =>
          p?.type === "text" && !!p.text,
      )
      .map((p) => p.text.trim())
      .filter(Boolean);
    return texts.join("\n") || null;
  }

  return null;
}

function pushMessageHistory(
  parts: string[],
  ctx: ConversationSwitchContext,
): void {
  if (!ctx.messageHistory || ctx.messageHistory.length === 0) return;

  const relevant = ctx.messageHistory
    .filter(
      (m) =>
        m.message_type === "user_message" ||
        m.message_type === "assistant_message",
    )
    .slice(-MAX_HISTORY_MESSAGES);

  if (relevant.length === 0) return;

  parts.push("Recent conversation messages:");
  for (const msg of relevant) {
    const text = extractMessageText(msg);
    if (!text) continue;
    const role = msg.message_type === "user_message" ? "user" : "assistant";
    const clipped =
      text.length > MAX_MESSAGE_CHARS
        ? `${text.slice(0, MAX_MESSAGE_CHARS)}...`
        : text;
    parts.push(`[${role}] ${clipped}`);
  }
}
