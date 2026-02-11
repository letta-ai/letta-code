const SYSTEM_ALERT_OPEN = "<system-alert>";
const SYSTEM_ALERT_CLOSE = "</system-alert>";

export interface ConversationSwitchPreviewLine {
  role: "user" | "assistant";
  text: string;
}

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
  previewLines?: ConversationSwitchPreviewLine[];

  searchQuery?: string;
  searchMessagePreview?: string;

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
    if (ctx.searchMessagePreview) {
      parts.push(`Selected message: "${ctx.searchMessagePreview}"`);
    }
    pushConversationMeta(parts, ctx);
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
    pushConversationPreview(parts, ctx);
    parts.push("Review the in-context messages for full conversation history.");
  } else {
    const via =
      ctx.origin === "resume-selector" ? "/resume selector" : "/resume";
    parts.push(`Conversation resumed via ${via}.`);
    pushConversationMeta(parts, ctx);
    pushConversationPreview(parts, ctx);
    parts.push("Review the in-context messages for full conversation history.");
  }

  return `${SYSTEM_ALERT_OPEN}${parts.join("\n")}${SYSTEM_ALERT_CLOSE}\n\n`;
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

function pushConversationPreview(
  parts: string[],
  ctx: ConversationSwitchContext,
): void {
  if (ctx.previewLines && ctx.previewLines.length > 0) {
    parts.push("The user saw this preview when selecting:");
    for (const line of ctx.previewLines) {
      const emoji = line.role === "assistant" ? "👾" : "👤";
      parts.push(`  ${emoji} ${line.text}`);
    }
  }
}
