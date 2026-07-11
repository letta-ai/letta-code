import type { StreamDelta } from "@/types/protocol_v2";
import {
  asRecord,
  type ChannelTurnProgressBuilderOptions,
  firstNonEmptyString,
  formatToolProgressDetails,
  formatToolProgressTitle,
  MAX_PROGRESS_DETAILS_LENGTH,
  parseToolArguments,
  sanitizeChannelProgressIdentifier,
  sanitizeChannelProgressText,
  type ToolCallSummary,
  type ToolReturnSummary,
} from "./progress-formatting";
import type { ChannelTurnProgressUpdate } from "./types";

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

function stringifyProgressValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolErrorDetails(
  record: Record<string, unknown>,
): string | undefined {
  const toolReturn = record.tool_return ?? record.toolReturn;
  const toolReturnRecord = asRecord(toolReturn);
  const preview = firstNonEmptyString(
    record.stderr,
    record.error,
    record.message,
    toolReturnRecord?.stderr,
    toolReturnRecord?.error,
    toolReturnRecord?.message,
    toolReturnRecord?.output,
    stringifyProgressValue(toolReturn),
  );
  const sanitized = sanitizeChannelProgressText(
    preview,
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

function toolNameForMessage(summary: ToolCallSummary | undefined): string {
  return summary?.name ? `: ${summary.name}` : "";
}

/**
 * Builds sanitized channel progress updates from stream deltas for a single
 * turn. Instances accumulate fragmented tool-call arguments across deltas,
 * so they must be scoped to one conversation turn (create one per turn and
 * drop it when the turn finishes) rather than shared across conversations.
 */
export type ChannelTurnProgressBuilder = {
  buildUpdates(delta: StreamDelta): ChannelTurnProgressUpdate[];
};

export function createChannelTurnProgressBuilder(
  options: ChannelTurnProgressBuilderOptions = {},
): ChannelTurnProgressBuilder {
  // Fragmented tool arguments and names accumulated across stream deltas,
  // keyed by tool_call_id. Entries are dropped when the tool return arrives;
  // the whole builder is dropped with the turn.
  const argumentsByToolCallId = new Map<string, string>();
  const namesByToolCallId = new Map<string, string>();

  // Wire shapes (see ToolCall / ToolCallDelta in @letta-ai/letta-client and
  // the local backend projections): flat `tool_call_id` / `name` /
  // `arguments` fields, delivered either as `tool_calls` (array or single
  // delta object) or the deprecated `tool_call`.
  function extractToolCallSummary(value: unknown): ToolCallSummary | null {
    const record = asRecord(value);
    if (!record) {
      return null;
    }
    const id = firstNonEmptyString(record.tool_call_id);
    const cacheId = id
      ? sanitizeChannelProgressIdentifier(id, "tool-call")
      : undefined;
    const extractedName = firstNonEmptyString(record.name);
    if (cacheId && extractedName) {
      namesByToolCallId.set(cacheId, extractedName);
    }
    const resolvedName =
      extractedName ?? (cacheId ? namesByToolCallId.get(cacheId) : undefined);
    const rawArguments =
      typeof record.arguments === "string" && record.arguments.length > 0
        ? record.arguments
        : asRecord(record.arguments)
          ? JSON.stringify(record.arguments)
          : undefined;

    // Accumulate fragmented arguments across stream deltas for the same tool
    // call. A fragment that already parses as complete JSON replaces earlier
    // partial state (some streams first expose only command content, then
    // later re-send full arguments including the description).
    let argumentsText: string | undefined;
    if (cacheId && rawArguments !== undefined) {
      const existing = argumentsByToolCallId.get(cacheId);
      if (parseToolArguments(rawArguments)) {
        argumentsByToolCallId.set(cacheId, rawArguments);
        argumentsText = rawArguments;
      } else if (existing) {
        if (parseToolArguments(existing)) {
          argumentsText = existing;
        } else {
          const accumulated = existing + rawArguments;
          argumentsByToolCallId.set(cacheId, accumulated);
          argumentsText = accumulated;
        }
      } else {
        argumentsByToolCallId.set(cacheId, rawArguments);
        argumentsText = rawArguments;
      }
    } else if (!id && rawArguments !== undefined) {
      argumentsText = rawArguments;
    }

    if (!id && !resolvedName) {
      return null;
    }
    return {
      ...(cacheId ? { id: cacheId } : {}),
      ...(resolvedName
        ? { name: sanitizeChannelProgressIdentifier(resolvedName, "tool") }
        : {}),
      ...(argumentsText ? { argumentsText } : {}),
    };
  }

  function extractClientToolSummary(
    record: Record<string, unknown>,
  ): ToolCallSummary | null {
    const id = firstNonEmptyString(record.tool_call_id, record.toolCallId);
    const cacheId = id
      ? sanitizeChannelProgressIdentifier(id, "tool-call")
      : undefined;
    const extractedName = firstNonEmptyString(
      record.tool_name,
      record.toolName,
      record.name,
    );
    if (cacheId && extractedName) {
      namesByToolCallId.set(cacheId, extractedName);
    }
    const resolvedName =
      extractedName ?? (cacheId ? namesByToolCallId.get(cacheId) : undefined);
    const rawArguments = firstNonEmptyString(
      record.tool_args,
      record.toolArgs,
      record.arguments,
    );
    if (cacheId && rawArguments) {
      argumentsByToolCallId.set(cacheId, rawArguments);
    }
    const argumentsText =
      rawArguments ??
      (cacheId ? argumentsByToolCallId.get(cacheId) : undefined);
    if (!cacheId && !resolvedName) {
      return null;
    }
    return {
      ...(cacheId ? { id: cacheId } : {}),
      ...(resolvedName
        ? { name: sanitizeChannelProgressIdentifier(resolvedName, "tool") }
        : {}),
      ...(argumentsText ? { argumentsText } : {}),
    };
  }

  function extractToolCalls(delta: Record<string, unknown>): ToolCallSummary[] {
    const candidates: unknown[] = Array.isArray(delta.tool_calls)
      ? delta.tool_calls
      : delta.tool_calls
        ? [delta.tool_calls]
        : delta.tool_call
          ? [delta.tool_call]
          : [];

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
    const candidates: unknown[] = Array.isArray(delta.tool_returns)
      ? delta.tool_returns
      : [delta];

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
      const status = getToolStatus(record);
      summaries.push({
        summary,
        status,
        ...(status === "error"
          ? { errorDetails: formatToolErrorDetails(record) }
          : {}),
      });
    }
    return summaries;
  }

  function buildToolCallUpdates(
    record: Record<string, unknown>,
    runId: string | undefined,
  ): ChannelTurnProgressUpdate[] {
    const tools = extractToolCalls(record);
    const updates: ChannelTurnProgressUpdate[] = [];
    for (const tool of tools) {
      const toolDetails = formatToolProgressDetails(tool, options);
      const toolTitle = formatToolProgressTitle(tool, "started");
      updates.push(
        withRunId(
          {
            kind: "tool",
            state: "started",
            message: `Preparing tool${toolNameForMessage(tool)}`,
            ...(tool.id ? { toolCallId: tool.id } : {}),
            ...(tool.name ? { toolName: tool.name } : {}),
            ...(toolDetails ? { toolDetails } : {}),
            ...(toolTitle ? { toolTitle } : {}),
          },
          runId,
        ),
      );
    }
    return updates;
  }

  function buildUpdates(delta: StreamDelta): ChannelTurnProgressUpdate[] {
    const record = asRecord(delta);
    if (!record) {
      return [];
    }

    const messageType = getMessageType(record);
    const runId = getRunId(record);

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

      case "approval_request_message":
        return buildToolCallUpdates(record, runId);

      case "tool_call_message": {
        const updates = buildToolCallUpdates(record, runId);
        if (updates.length === 0) {
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
        return updates;
      }

      case "tool_return_message": {
        const toolReturns = extractToolReturns(record);
        const updates: ChannelTurnProgressUpdate[] = [];
        for (const { summary, status, errorDetails } of toolReturns) {
          // Resolve details from the accumulated arguments for this call,
          // then drop the per-call caches.
          const accumulatedArgs = summary.id
            ? argumentsByToolCallId.get(summary.id)
            : undefined;
          if (summary.id) {
            argumentsByToolCallId.delete(summary.id);
            namesByToolCallId.delete(summary.id);
          }
          const toolWithAccumulatedArgs = accumulatedArgs
            ? { ...summary, argumentsText: accumulatedArgs }
            : summary;
          // toolDetails stays argument-derived even on errors: surfaces use it
          // for row titles (e.g. shell rows), so tool output must never leak
          // into it. Error-output previews travel in errorDetails (LET-9509).
          const toolDetails = formatToolProgressDetails(
            toolWithAccumulatedArgs,
            options,
          );
          const toolTitle = formatToolProgressTitle(
            toolWithAccumulatedArgs,
            status,
          );
          updates.push(
            withRunId(
              {
                kind: "tool",
                state: status,
                message: status === "error" ? "Tool failed" : "Tool finished",
                ...(summary.id ? { toolCallId: summary.id } : {}),
                ...(summary.name ? { toolName: summary.name } : {}),
                ...(toolDetails ? { toolDetails } : {}),
                ...(status === "error" && errorDetails ? { errorDetails } : {}),
                ...(toolTitle ? { toolTitle } : {}),
              },
              runId,
            ),
          );
        }
        return updates;
      }

      case "client_tool_start": {
        const tool = extractClientToolSummary(record);
        const toolDetails = tool
          ? formatToolProgressDetails(tool, options)
          : undefined;
        const toolTitle = tool
          ? formatToolProgressTitle(tool, "started")
          : undefined;
        return [
          withRunId(
            {
              kind: "tool",
              state: "started",
              message: "Running tool",
              ...(tool?.id ? { toolCallId: tool.id } : {}),
              ...(tool?.name ? { toolName: tool.name } : {}),
              ...(toolDetails ? { toolDetails } : {}),
              ...(toolTitle ? { toolTitle } : {}),
            },
            runId,
          ),
        ];
      }

      case "client_tool_end": {
        const state = getToolStatus(record);
        const tool = extractClientToolSummary(record);
        const accumulatedArgs = tool?.id
          ? argumentsByToolCallId.get(tool.id)
          : undefined;
        if (tool?.id) {
          argumentsByToolCallId.delete(tool.id);
          namesByToolCallId.delete(tool.id);
        }
        const toolWithAccumulatedArgs =
          tool && accumulatedArgs
            ? { ...tool, argumentsText: accumulatedArgs }
            : tool;
        // toolDetails stays argument-derived even on errors (see the
        // tool_return_message handler); error previews go to errorDetails.
        const toolDetails = toolWithAccumulatedArgs
          ? formatToolProgressDetails(toolWithAccumulatedArgs, options)
          : undefined;
        const errorDetails =
          state === "error" ? formatToolErrorDetails(record) : undefined;
        const toolTitle = toolWithAccumulatedArgs
          ? formatToolProgressTitle(toolWithAccumulatedArgs, state)
          : undefined;
        return [
          withRunId(
            {
              kind: "tool",
              state,
              message: state === "error" ? "Tool failed" : "Tool finished",
              ...(tool?.id ? { toolCallId: tool.id } : {}),
              ...(tool?.name ? { toolName: tool.name } : {}),
              ...(toolDetails ? { toolDetails } : {}),
              ...(errorDetails ? { errorDetails } : {}),
              ...(toolTitle ? { toolTitle } : {}),
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

  return { buildUpdates };
}
