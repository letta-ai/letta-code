import { formatArgsDisplay } from "@/cli/helpers/format-args-display";
import { isShellTool } from "@/cli/helpers/tool-name-mapping";
import {
  formatWebSearchProgressTitle,
  isWebSearchToolName,
} from "@/cli/helpers/web-search-display";
import type { StreamDelta } from "@/types/protocol_v2";
import type { ChannelTurnProgressUpdate } from "./types";

const MAX_PROGRESS_TEXT_LENGTH = 140;
const MAX_PROGRESS_DETAILS_LENGTH = 180;
const ESCAPE_CODE = String.fromCharCode(27);
const ANSI_ESCAPE_RE = new RegExp(`${ESCAPE_CODE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_JSON_RE =
  /(["']?(?:token|secret|password|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function replaceControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = character.charCodeAt(0);
    result +=
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
        ? " "
        : character;
  }
  return result;
}

export function sanitizeChannelProgressText(
  value: unknown,
  maxLength: number = MAX_PROGRESS_TEXT_LENGTH,
): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const redacted = raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(SECRET_ASSIGNMENT_RE, "$1=[redacted]")
    .replace(SECRET_JSON_RE, "$1[redacted]");
  const normalized = replaceControlCharacters(redacted)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/@(?=channel|here|everyone|[A-Za-z0-9._-]+)/gi, "@\u200b")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(normalized, maxLength);
}

export function sanitizeChannelProgressIdentifier(
  value: unknown,
  fallback: string,
): string {
  const text = sanitizeChannelProgressText(value, 64);
  if (!text) {
    return fallback;
  }
  const cleaned = text.replace(/[^A-Za-z0-9_.:/ -]/g, "").trim();
  return cleaned || fallback;
}

type ToolCallSummary = {
  id?: string;
  name?: string;
  argumentsText?: string;
};

type ToolReturnSummary = {
  summary: ToolCallSummary;
  status: "completed" | "error";
};

function parseToolArguments(
  value: string | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function formatToolProgressTitle(
  summary: ToolCallSummary,
  state: ChannelTurnProgressUpdate["state"],
): string | undefined {
  const parsedArguments = parseToolArguments(summary.argumentsText);
  if (isWebSearchToolName(summary.name)) {
    const title = formatWebSearchProgressTitle(parsedArguments ?? {}, state);
    const sanitized = sanitizeChannelProgressText(title);
    return sanitized || undefined;
  }

  if (summary.name && isShellTool(summary.name) && parsedArguments) {
    const description = firstNonEmptyString(parsedArguments.description);
    const sanitized = sanitizeChannelProgressText(description);
    if (sanitized) {
      return `Bash: ${sanitized}`;
    }
  }

  return undefined;
}

function formatToolProgressDetails(
  summary: ToolCallSummary,
): string | undefined {
  if (!summary.argumentsText || !summary.name) {
    return undefined;
  }
  if (!parseToolArguments(summary.argumentsText)) {
    return undefined;
  }

  // Keep Slack task rows compact. Non-shell inputs are often duplicated by the
  // title or too verbose for the native card; shell commands are the one detail
  // worth keeping because descriptions can hide the exact command being run.
  if (!isShellTool(summary.name)) {
    return undefined;
  }

  const { display } = formatArgsDisplay(summary.argumentsText, summary.name);
  const sanitized = sanitizeChannelProgressText(
    display,
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  if (!sanitized || sanitized === "…") {
    return undefined;
  }
  return `Command: ${sanitized}`;
}

function extractToolCallSummary(value: unknown): ToolCallSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const nestedFunction = asRecord(record.function);
  const tool = asRecord(record.tool);
  const nestedToolFunction = asRecord(tool?.function);
  const id = firstNonEmptyString(
    record.id,
    record.tool_call_id,
    record.toolCallId,
    record.call_id,
  );
  const name = firstNonEmptyString(
    record.name,
    record.tool_name,
    record.toolName,
    nestedFunction?.name,
    tool?.name,
    nestedToolFunction?.name,
  );
  const argumentsText = firstNonEmptyString(
    record.arguments,
    record.args,
    record.input,
    nestedFunction?.arguments,
    nestedFunction?.args,
    tool?.arguments,
    nestedToolFunction?.arguments,
    nestedToolFunction?.args,
  );
  if (!id && !name) {
    return null;
  }
  return {
    ...(id ? { id: sanitizeChannelProgressIdentifier(id, "tool-call") } : {}),
    ...(name ? { name: sanitizeChannelProgressIdentifier(name, "tool") } : {}),
    ...(argumentsText ? { argumentsText } : {}),
  };
}

function extractToolCalls(delta: Record<string, unknown>): ToolCallSummary[] {
  const candidates: unknown[] = [];
  if (Array.isArray(delta.tool_calls)) {
    candidates.push(...delta.tool_calls);
  }
  if (Array.isArray(delta.toolCalls)) {
    candidates.push(...delta.toolCalls);
  }
  if (Array.isArray(delta.tools)) {
    candidates.push(...delta.tools);
  }
  if (Array.isArray(delta.approvals)) {
    candidates.push(...delta.approvals);
  }
  candidates.push(delta.tool_call, delta.toolCall, delta.approval);

  const summaries: ToolCallSummary[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const summary = extractToolCallSummary(candidate);
    if (!summary) {
      continue;
    }
    const key = `${summary.id ?? ""}:${summary.name ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    summaries.push(summary);
  }
  return summaries;
}

function extractToolReturns(
  delta: Record<string, unknown>,
): ToolReturnSummary[] {
  const candidates: unknown[] = [];
  if (Array.isArray(delta.tool_returns)) {
    candidates.push(...delta.tool_returns);
  }
  if (Array.isArray(delta.toolReturns)) {
    candidates.push(...delta.toolReturns);
  }
  if (candidates.length === 0) {
    candidates.push(delta);
  }

  const summaries: ToolReturnSummary[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }
    const summary = extractToolCallSummary(record);
    if (!summary) {
      continue;
    }
    const key = `${summary.id ?? ""}:${summary.name ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    summaries.push({
      summary,
      status: getToolStatus(record),
    });
  }
  return summaries;
}

function getMessageType(delta: Record<string, unknown>): string | null {
  return firstNonEmptyString(delta.message_type, delta.messageType) ?? null;
}

function getRunId(delta: Record<string, unknown>): string | undefined {
  return firstNonEmptyString(delta.run_id, delta.runId);
}

function withRunId(
  update: Omit<ChannelTurnProgressUpdate, "runId">,
  runId?: string,
): ChannelTurnProgressUpdate {
  return {
    ...update,
    ...(runId ? { runId } : {}),
  };
}

function getCommandId(delta: Record<string, unknown>): string {
  const command = firstNonEmptyString(delta.command_id, delta.commandId);
  return sanitizeChannelProgressIdentifier(command, "command");
}

function getSlashCommand(delta: Record<string, unknown>): string {
  const commandId = firstNonEmptyString(delta.command_id, delta.commandId);
  const command = commandId ? `/${commandId.replace(/^\/+/, "")}` : "command";
  return sanitizeChannelProgressIdentifier(command, "command");
}

function getToolStatus(delta: Record<string, unknown>): "completed" | "error" {
  const status = firstNonEmptyString(delta.status)?.toLowerCase();
  return status === "error" || status === "failed" ? "error" : "completed";
}

function toolNameForMessage(summary: ToolCallSummary | undefined): string {
  return summary?.name ? `: ${summary.name}` : "";
}

export function buildChannelTurnProgressUpdatesFromDelta(
  delta: StreamDelta,
): ChannelTurnProgressUpdate[] {
  const record = asRecord(delta);
  if (!record) {
    return [];
  }

  const messageType = getMessageType(record);
  const runId = getRunId(record);
  const updates: ChannelTurnProgressUpdate[] = [];

  switch (messageType) {
    case "reasoning_message":
      return [
        withRunId(
          {
            kind: "thinking",
            state: "updated",
            message: "Thinking",
          },
          runId,
        ),
      ];

    case "assistant_message":
      return [
        withRunId(
          {
            kind: "responding",
            state: "updated",
            message: "Writing reply",
          },
          runId,
        ),
      ];

    case "approval_request_message": {
      const tools = extractToolCalls(record);
      if (tools.length === 0) {
        return [
          withRunId(
            {
              kind: "approval",
              state: "waiting",
              message: "Waiting for tool approval",
            },
            runId,
          ),
        ];
      }
      for (const tool of tools) {
        const toolTitle = formatToolProgressTitle(tool, "waiting");
        const toolDetails = formatToolProgressDetails(tool);
        updates.push(
          withRunId(
            {
              kind: "approval",
              state: "waiting",
              message: `Waiting for approval${toolNameForMessage(tool)}`,
              ...(tool.id ? { toolCallId: tool.id } : {}),
              ...(tool.name ? { toolName: tool.name } : {}),
              ...(toolTitle ? { toolTitle } : {}),
              ...(toolDetails ? { toolDetails } : {}),
            },
            runId,
          ),
        );
      }
      return updates;
    }

    case "tool_call_message": {
      const tools = extractToolCalls(record);
      if (tools.length === 0) {
        return [
          withRunId(
            {
              kind: "tool",
              state: "started",
              message: "Preparing tool call",
            },
            runId,
          ),
        ];
      }
      for (const tool of tools) {
        const toolTitle = formatToolProgressTitle(tool, "started");
        const toolDetails = formatToolProgressDetails(tool);
        updates.push(
          withRunId(
            {
              kind: "tool",
              state: "started",
              message: `Preparing tool${toolNameForMessage(tool)}`,
              ...(tool.id ? { toolCallId: tool.id } : {}),
              ...(tool.name ? { toolName: tool.name } : {}),
              ...(toolTitle ? { toolTitle } : {}),
              ...(toolDetails ? { toolDetails } : {}),
            },
            runId,
          ),
        );
      }
      return updates;
    }

    case "tool_return_message": {
      const toolReturns = extractToolReturns(record);
      if (toolReturns.length === 0) {
        return [];
      }
      for (const { summary, status } of toolReturns) {
        updates.push(
          withRunId(
            {
              kind: "tool",
              state: status,
              message: status === "error" ? "Tool failed" : "Tool finished",
              ...(summary.id ? { toolCallId: summary.id } : {}),
              ...(summary.name ? { toolName: summary.name } : {}),
            },
            runId,
          ),
        );
      }
      return updates;
    }

    case "client_tool_start":
      return [
        withRunId(
          {
            kind: "tool",
            state: "started",
            message: "Running tool",
            ...(typeof record.tool_call_id === "string"
              ? {
                  toolCallId: sanitizeChannelProgressIdentifier(
                    record.tool_call_id,
                    "tool-call",
                  ),
                }
              : {}),
          },
          runId,
        ),
      ];

    case "client_tool_end": {
      const state = getToolStatus(record);
      return [
        withRunId(
          {
            kind: "tool",
            state,
            message: state === "error" ? "Tool failed" : "Tool finished",
            ...(typeof record.tool_call_id === "string"
              ? {
                  toolCallId: sanitizeChannelProgressIdentifier(
                    record.tool_call_id,
                    "tool-call",
                  ),
                }
              : {}),
          },
          runId,
        ),
      ];
    }

    case "slash_command_start": {
      const command = getSlashCommand(record);
      return [
        withRunId(
          {
            kind: "command",
            state: "started",
            message: `Running ${command}`,
            command,
          },
          runId,
        ),
      ];
    }

    case "slash_command_end": {
      const command = getSlashCommand(record);
      const success = record.success !== false;
      return [
        withRunId(
          {
            kind: "command",
            state: success ? "completed" : "error",
            message: success ? `${command} finished` : `${command} failed`,
            command,
          },
          runId,
        ),
      ];
    }

    case "command_start": {
      const command = getCommandId(record);
      return [
        withRunId(
          {
            kind: "command",
            state: "started",
            message: "Running command",
            command,
          },
          runId,
        ),
      ];
    }

    case "command_end": {
      const command = getCommandId(record);
      const success = record.success !== false;
      return [
        withRunId(
          {
            kind: "command",
            state: success ? "completed" : "error",
            message: success ? "Command finished" : "Command failed",
            command,
          },
          runId,
        ),
      ];
    }

    case "status": {
      const message = sanitizeChannelProgressText(record.message);
      if (!message) {
        return [];
      }
      return [
        withRunId(
          {
            kind: "status",
            state: "updated",
            message,
          },
          runId,
        ),
      ];
    }

    case "retry": {
      const attempt = Number(record.attempt);
      const maxAttempts = Number(record.max_attempts ?? record.maxAttempts);
      const suffix =
        Number.isFinite(attempt) && Number.isFinite(maxAttempts)
          ? ` (${attempt}/${maxAttempts})`
          : "";
      return [
        withRunId(
          {
            kind: "retry",
            state: "updated",
            message: `Retrying request${suffix}`,
          },
          runId,
        ),
      ];
    }

    case "loop_error":
      return [
        withRunId(
          {
            kind: "error",
            state: "error",
            message: "Encountered an error",
          },
          runId,
        ),
      ];

    default:
      return [];
  }
}
