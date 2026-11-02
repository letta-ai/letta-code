/** A tool call made by a Claude Code or Codex worker, shown as subagent progress. */
export interface ExternalToolCall {
  id: string;
  name: string;
  /** JSON arguments, truncated for display. */
  args: string;
  /** The full, untruncated arguments, for the task's event log. */
  input?: unknown;
}

export type ExternalToolCallListener = (call: ExternalToolCall) => void;

/** Called with each assistant text block a Claude Code or Codex worker emits. */
export type ExternalTextListener = (text: string) => void;

/** The outcome of a worker's tool call, with its full output. */
export interface ExternalToolResult {
  /** ID of the tool call this result answers. */
  id: string;
  name?: string;
  isError: boolean;
  output: string;
}

/** Live-progress callbacks shared by every external worker type. */
export interface ExternalWorkerListeners {
  /** Called once per tool call the worker makes. */
  onToolCall?: ExternalToolCallListener;
  /** Called with each assistant text block (Claude Code, Codex). */
  onText?: ExternalTextListener;
  /** Called once per finished tool call, with its full output. */
  onToolResult?: (result: ExternalToolResult) => void;
  /** Called with each reasoning (thinking) block the worker exposes. */
  onReasoning?: (text: string) => void;
}

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

/** Parse a JSON argument string, keeping the raw string if it is not JSON. */
export function parseToolInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** Render a tool result's content (string, content blocks, or JSON) as text. */
export function toolOutputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part?.text === "string" ? part.text : toolOutputText(part),
      )
      .join("\n");
  }
  return JSON.stringify(value) ?? String(value);
}

/** Invoke an optional progress callback; progress must never break a turn. */
export function emitProgress<T>(
  listener: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    listener?.(value);
  } catch {
    // Progress display must not break the worker.
  }
}
