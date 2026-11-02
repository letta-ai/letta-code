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

export type ExternalToolResultListener = (result: ExternalToolResult) => void;

/** Called with each reasoning (thinking) block a worker exposes. */
export type ExternalReasoningListener = (text: string) => void;

/** Called once the worker's native session transcript file is known. */
export type ExternalTranscriptListener = (path: string) => void;

/** Optional live-progress callbacks shared by every external worker type. */
export interface ExternalWorkerListeners {
  /** Called once per tool call the worker makes. */
  onToolCall?: ExternalToolCallListener;
  /** Called with each assistant text block (Claude Code, Codex). */
  onText?: ExternalTextListener;
  /** Called once per finished tool call, with its full output. */
  onToolResult?: ExternalToolResultListener;
  /** Called with each reasoning block the worker exposes. */
  onReasoning?: ExternalReasoningListener;
  /** Called with the path of the worker's own session transcript. */
  onTranscript?: ExternalTranscriptListener;
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
export function parseToolInput(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
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
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        )
          return (part as { text: string }).text;
        try {
          return JSON.stringify(part);
        } catch {
          return "";
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Safely invoke an optional progress callback; progress must never break a turn. */
export function emitProgress<T>(
  listener: ((value: T) => void) | undefined,
  value: T,
): void {
  if (!listener) return;
  try {
    listener(value);
  } catch {
    // Progress display must not break the worker.
  }
}
