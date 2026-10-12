/** A tool call made by a Claude Code or Codex worker, shown as subagent progress. */
export interface ExternalToolCall {
  id: string;
  name: string;
  /** JSON arguments, truncated for display. */
  args: string;
}

export type ExternalToolCallListener = (call: ExternalToolCall) => void;

const MAX_TOOL_CALL_ARGS_LENGTH = 1_000;

/** Serialize tool arguments compactly, capped so progress snapshots stay small. */
export function formatExternalToolCallArgs(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    json = "{}";
  }
  return json.length > MAX_TOOL_CALL_ARGS_LENGTH
    ? `${json.slice(0, MAX_TOOL_CALL_ARGS_LENGTH)}…`
    : json;
}
