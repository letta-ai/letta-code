export interface ExternalToolCall {
  id: string;
  name: string;
  args: string;
  input?: unknown;
}

export type ExternalToolCallListener = (call: ExternalToolCall) => void;

export type ExternalTextListener = (text: string) => void;

export interface ExternalToolResult {
  id: string;
  name?: string;
  isError: boolean;
  output: string;
}

export interface ExternalWorkerListeners {
  onToolCall?: ExternalToolCallListener;
  onText?: ExternalTextListener;
  onToolResult?: (result: ExternalToolResult) => void;
  onReasoning?: (text: string) => void;
}

const MAX_TOOL_CALL_ARGS_LENGTH = 1_000;

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

export function parseToolInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

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

export function emitProgress<T>(
  listener: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    listener?.(value);
  } catch {}
}
