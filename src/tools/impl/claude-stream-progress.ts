import {
  type ExternalWorkerListeners,
  emitProgress,
  formatExternalToolCallArgs,
  toolOutputText,
} from "./external-tool-call";

/**
 * Live progress from a Claude Code stream-json session: its tool calls, tool
 * results, text, and thinking, each reported once (Claude Code can repeat a
 * message).
 */
export interface ClaudeProgress
  extends Partial<
    Pick<
      ExternalWorkerListeners,
      "onToolCall" | "onText" | "onToolResult" | "onReasoning"
    >
  > {
  seenToolCallIds: Set<string>;
  /** Message ID + text of blocks already reported. */
  seenTextBlocks: Set<string>;
  seenToolResultIds: Set<string>;
  /** Tool names by `tool_use` ID, so results can name their tool. */
  toolNames: Map<string, string>;
}

export function createClaudeProgress(
  listeners: Partial<ExternalWorkerListeners>,
): ClaudeProgress {
  return {
    onToolCall: listeners.onToolCall,
    onText: listeners.onText,
    onToolResult: listeners.onToolResult,
    onReasoning: listeners.onReasoning,
    seenToolCallIds: new Set(),
    seenTextBlocks: new Set(),
    seenToolResultIds: new Set(),
    toolNames: new Map(),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function reportText(
  progress: ClaudeProgress,
  messageId: unknown,
  text: unknown,
): void {
  if (!progress.onText || typeof text !== "string" || !text.trim()) return;
  // Cap the key so a long session does not retain every full text block.
  const key = `${typeof messageId === "string" ? messageId : ""}\u0000${text.slice(0, 1_000)}`;
  if (progress.seenTextBlocks.has(key)) return;
  progress.seenTextBlocks.add(key);
  emitProgress(progress.onText, text);
}

/** Report each text, thinking, and `tool_use` block of an `assistant` message once. */
export function handleClaudeAssistant(
  progress: ClaudeProgress,
  value: Record<string, unknown>,
): void {
  const message = readRecord(value.message);
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    const block = readRecord(entry);
    if (block?.type === "text") {
      reportText(progress, message?.id, block.text);
      continue;
    }
    if (block?.type === "thinking") {
      if (typeof block.thinking === "string" && block.thinking.trim())
        emitProgress(progress.onReasoning, block.thinking);
      continue;
    }
    if (
      block?.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string" ||
      progress.seenToolCallIds.has(block.id)
    )
      continue;
    progress.seenToolCallIds.add(block.id);
    progress.toolNames.set(block.id, block.name);
    emitProgress(progress.onToolCall, {
      id: block.id,
      name: block.name,
      args: formatExternalToolCallArgs(block.input),
      input: block.input,
    });
  }
}

/** Report each `tool_result` block of a `user` message once, in full. */
export function handleClaudeToolResults(
  progress: ClaudeProgress,
  value: Record<string, unknown>,
): void {
  if (!progress.onToolResult) return;
  const content = readRecord(value.message)?.content;
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    const block = readRecord(entry);
    if (
      block?.type !== "tool_result" ||
      typeof block.tool_use_id !== "string" ||
      progress.seenToolResultIds.has(block.tool_use_id)
    )
      continue;
    progress.seenToolResultIds.add(block.tool_use_id);
    emitProgress(progress.onToolResult, {
      id: block.tool_use_id,
      name: progress.toolNames.get(block.tool_use_id),
      isError: block.is_error === true,
      output: toolOutputText(block.content),
    });
  }
}
