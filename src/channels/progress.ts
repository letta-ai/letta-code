import {
  getDisplayToolName,
  isShellTool,
} from "@/cli/helpers/tool-name-mapping";
import { isWebSearchToolName } from "@/cli/helpers/web-search-display";
import type { StreamDelta } from "@/types/protocol_v2";
import type { ChannelTurnProgressUpdate } from "./types";

// Accumulate fragmented tool arguments across stream deltas.
// Keyed by tool_call_id; values are the accumulated argument strings.
const toolCallArgumentsById = new Map<string, string>();
const toolCallNamesById = new Map<string, string>();
const toolCallDescriptionsById = new Map<string, string>();

export function clearToolCallArgumentsCache(): void {
  toolCallArgumentsById.clear();
  toolCallNamesById.clear();
  toolCallDescriptionsById.clear();
}

const MAX_PROGRESS_TEXT_LENGTH = 140;
const MAX_PROGRESS_DETAILS_LENGTH = 180;
const MAX_SHELL_PROGRESS_DETAILS_LENGTH = 64;
const ESCAPE_CODE = String.fromCharCode(27);
const ANSI_ESCAPE_RE = new RegExp(`${ESCAPE_CODE}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_JSON_RE =
  /(["']?(?:token|secret|password|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

function debugChannelProgress(message: string): void {
  if (process.env.LETTA_SLACK_PROGRESS_DEBUG === "1") {
    console.debug(`[Channel progress] ${message}`);
  }
}

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

function summarizeShellCommand(command: string): string {
  const normalized = sanitizeChannelProgressText(command, 10_000);
  if (!normalized) {
    return "";
  }

  const firstSemicolonSegments = normalized
    .split(/\s*;\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const firstTwoSegments = firstSemicolonSegments.slice(0, 2).join("; ");
  const previewSource =
    firstTwoSegments.length > 0 && firstTwoSegments.length <= 70
      ? firstTwoSegments
      : (firstSemicolonSegments[0] ?? normalized);
  const withoutPipeline = previewSource.split(/\s*\|\s*/)[0] ?? previewSource;
  const withoutHugePattern = withoutPipeline.replace(
    /\s+-Pattern\s+.*$/i,
    " -Pattern …",
  );
  const withoutLineVariable = withoutHugePattern.replace(
    /^\$lines\s*=\s*/i,
    "",
  );

  if (withoutLineVariable.trim()) {
    return sanitizeChannelProgressText(
      withoutLineVariable,
      MAX_SHELL_PROGRESS_DETAILS_LENGTH,
    );
  }
  return sanitizeChannelProgressText(
    normalized,
    MAX_SHELL_PROGRESS_DETAILS_LENGTH,
  );
}

type ToolCallSummary = {
  id?: string;
  name?: string;
  argumentsText?: string;
  descriptionText?: string;
};

function formatShellProgressDetailsFromArguments(
  summary: ToolCallSummary,
  parsedArguments: Record<string, unknown>,
): string | undefined {
  const description = firstNonEmptyString(
    summary.descriptionText,
    parsedArguments.description,
  );
  if (description) {
    return (
      sanitizeChannelProgressText(description, MAX_PROGRESS_DETAILS_LENGTH) ||
      undefined
    );
  }

  const commandPreview = firstNonEmptyString(
    parsedArguments.command,
    parsedArguments.cmd,
  );
  return summarizeShellCommand(commandPreview ?? "") || undefined;
}

function formatFragmentedShellProgressDetails(
  summary: ToolCallSummary,
): string | undefined {
  const descriptionMatch = summary.argumentsText?.match(
    /"description"\s*:\s*"([^"]+)"/,
  );
  if (descriptionMatch?.[1]) {
    return (
      sanitizeChannelProgressText(
        descriptionMatch[1],
        MAX_PROGRESS_DETAILS_LENGTH,
      ) || undefined
    );
  }

  const commandMatch = summary.argumentsText?.match(
    /"(?:command|cmd)"\s*:\s*"([^"]+)"/,
  );
  if (commandMatch?.[1]) {
    return summarizeShellCommand(commandMatch[1]) || undefined;
  }

  return undefined;
}

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

function stringifyRecordArgument(value: unknown): string | undefined {
  const record = asRecord(value);
  return record ? JSON.stringify(record) : undefined;
}

function formatToolProgressTitle(
  summary: ToolCallSummary,
  state: ChannelTurnProgressUpdate["state"],
): string | undefined {
  if (isWebSearchToolName(summary.name)) {
    if (state === "completed") {
      return "Searched the web";
    }
    if (state === "error") {
      return "Attempted to search the web";
    }
    return "Searching the web";
  }

  if (summary.name && isShellTool(summary.name)) {
    return state === "completed" ? "Ran" : "Running";
  }

  if (summary.name) {
    const displayName = getDisplayToolName(summary.name);
    if (displayName !== summary.name) {
      const sanitized = sanitizeChannelProgressText(displayName);
      return sanitized || undefined;
    }
  }

  return undefined;
}

function isFetchWebpageToolName(name: string | undefined): boolean {
  return (
    name === "fetch_webpage" ||
    name === "FetchWebpage" ||
    name === "fetchWebpage"
  );
}

function isSkillToolName(name: string | undefined): boolean {
  return name === "Skill" || name === "skill";
}

function formatSkillProgressDetailsFromArguments(
  parsedArguments: Record<string, unknown>,
): string | undefined {
  const skillName = firstNonEmptyString(
    parsedArguments.skill,
    parsedArguments.skillName,
  );
  const sanitized = sanitizeChannelProgressText(
    skillName,
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

function formatFragmentedSkillProgressDetails(
  summary: ToolCallSummary,
): string | undefined {
  const skillMatch = summary.argumentsText?.match(
    /"(?:skill|skillName)"\s*:\s*"([^"]+)"/,
  );
  if (!skillMatch?.[1]) {
    return undefined;
  }
  const sanitized = sanitizeChannelProgressText(
    skillMatch[1],
    MAX_PROGRESS_DETAILS_LENGTH,
  );
  return sanitized || undefined;
}

function formatToolProgressDetails(
  summary: ToolCallSummary,
): string | undefined {
  if (!summary.name) {
    return undefined;
  }
  if (!summary.argumentsText) {
    if (isShellTool(summary.name)) {
      const sanitized = sanitizeChannelProgressText(
        summary.descriptionText,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }
    return undefined;
  }

  // Try JSON parse first (complete arguments)
  const parsedArguments = parseToolArguments(summary.argumentsText);
  if (parsedArguments) {
    if (isWebSearchToolName(summary.name)) {
      const query = firstNonEmptyString(parsedArguments.query);
      const sanitized = sanitizeChannelProgressText(
        query,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (isFetchWebpageToolName(summary.name)) {
      const url = firstNonEmptyString(parsedArguments.url);
      const sanitized = sanitizeChannelProgressText(
        url,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (isSkillToolName(summary.name)) {
      return formatSkillProgressDetailsFromArguments(parsedArguments);
    }

    if (isShellTool(summary.name)) {
      const description = firstNonEmptyString(
        summary.descriptionText,
        parsedArguments.description,
      );
      debugChannelProgress(
        `[DETAILS-BASH-PARSED] id=${summary.id ?? "none"} keys=${Object.keys(parsedArguments).join(",")} description=${description ?? "none"}`,
      );
      return formatShellProgressDetailsFromArguments(summary, parsedArguments);
    }

    if (summary.name === "Read" || summary.name === "read") {
      const filePath = firstNonEmptyString(
        parsedArguments.file_path,
        parsedArguments.filePath,
        parsedArguments.path,
      );
      const sanitized = sanitizeChannelProgressText(
        filePath,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (summary.name === "Glob" || summary.name === "glob") {
      const pattern = firstNonEmptyString(parsedArguments.pattern);
      const sanitized = sanitizeChannelProgressText(
        pattern,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (summary.name === "Grep" || summary.name === "grep") {
      const pattern = firstNonEmptyString(parsedArguments.pattern);
      const sanitized = sanitizeChannelProgressText(
        pattern,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (summary.name === "Edit" || summary.name === "edit") {
      const filePath = firstNonEmptyString(
        parsedArguments.file_path,
        parsedArguments.filePath,
      );
      const sanitized = sanitizeChannelProgressText(
        filePath,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    if (summary.name === "Write" || summary.name === "write") {
      const filePath = firstNonEmptyString(
        parsedArguments.file_path,
        parsedArguments.filePath,
      );
      const sanitized = sanitizeChannelProgressText(
        filePath,
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }

    return undefined;
  }

  // Fallback: try to extract description from fragmented/incomplete JSON
  if (isShellTool(summary.name)) {
    const details = formatFragmentedShellProgressDetails(summary);
    debugChannelProgress(
      `[DETAILS-BASH-FALLBACK] id=${summary.id ?? "none"} matched=${details ?? "none"} text=${sanitizeChannelProgressText(summary.argumentsText, MAX_PROGRESS_DETAILS_LENGTH)}`,
    );
    return details;
  }

  if (isSkillToolName(summary.name)) {
    return formatFragmentedSkillProgressDetails(summary);
  }

  // Fallback: try to extract file_path from fragmented/incomplete JSON
  if (
    summary.name === "Read" ||
    summary.name === "read" ||
    summary.name === "Edit" ||
    summary.name === "edit" ||
    summary.name === "Write" ||
    summary.name === "write"
  ) {
    const filePathMatch = summary.argumentsText.match(
      /"file_path"\s*:\s*"([^"]+)"/,
    );
    if (filePathMatch?.[1]) {
      const sanitized = sanitizeChannelProgressText(
        filePathMatch[1],
        MAX_PROGRESS_DETAILS_LENGTH,
      );
      return sanitized || undefined;
    }
  }

  return undefined;
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
  const cacheId = id
    ? sanitizeChannelProgressIdentifier(id, "tool-call")
    : undefined;
  const extractedName = firstNonEmptyString(
    record.name,
    record.tool_name,
    record.toolName,
    nestedFunction?.name,
    tool?.name,
    nestedToolFunction?.name,
  );
  if (cacheId && extractedName) {
    toolCallNamesById.set(cacheId, extractedName);
  }
  const name =
    extractedName ?? (cacheId ? toolCallNamesById.get(cacheId) : undefined);
  const descriptionText = firstNonEmptyString(
    record.description,
    record.display_description,
    record.displayDescription,
    record.summary,
    record.reason,
    record.purpose,
    nestedFunction?.description,
    tool?.description,
    nestedToolFunction?.description,
  );
  if (cacheId && descriptionText) {
    toolCallDescriptionsById.set(
      cacheId,
      sanitizeChannelProgressText(descriptionText, MAX_PROGRESS_DETAILS_LENGTH),
    );
  }
  const resolvedName = name;
  const resolvedDescriptionText =
    descriptionText ??
    (cacheId ? toolCallDescriptionsById.get(cacheId) : undefined);
  const rawArguments =
    firstNonEmptyString(
      record.arguments,
      record.args,
      record.input,
      nestedFunction?.arguments,
      nestedFunction?.args,
      tool?.arguments,
      nestedToolFunction?.arguments,
      nestedToolFunction?.args,
    ) ??
    stringifyRecordArgument(record.arguments) ??
    stringifyRecordArgument(record.args) ??
    stringifyRecordArgument(record.input) ??
    stringifyRecordArgument(nestedFunction?.arguments) ??
    stringifyRecordArgument(nestedFunction?.args) ??
    stringifyRecordArgument(tool?.arguments) ??
    stringifyRecordArgument(tool?.args) ??
    stringifyRecordArgument(tool?.input) ??
    stringifyRecordArgument(nestedToolFunction?.arguments) ??
    stringifyRecordArgument(nestedToolFunction?.args);

  if (resolvedName && isShellTool(resolvedName)) {
    debugChannelProgress(
      `[EXTRACT-BASH] id=${id ?? "none"} keys=${Object.keys(record).join(",")} descriptionText=${resolvedDescriptionText ?? "none"} rawType=${typeof rawArguments} raw=${sanitizeChannelProgressText(rawArguments, MAX_PROGRESS_DETAILS_LENGTH)}`,
    );
  }

  // Accumulate fragmented arguments across stream deltas for the same tool call.
  // If the current fragment already parses as valid JSON, use it directly
  // and don't accumulate further (prevents duplication when complete args
  // are sent in every delta).
  let argumentsText: string | undefined;
  if (cacheId && rawArguments !== undefined) {
    const existing = toolCallArgumentsById.get(cacheId);
    const rawArgumentsAreComplete = parseToolArguments(rawArguments) !== null;
    if (rawArgumentsAreComplete) {
      // Complete current arguments should replace earlier partial/object args.
      // Some streams first expose only command content, then later include the
      // human-friendly description; freezing the first parseable object hides it.
      toolCallArgumentsById.set(cacheId, rawArguments);
      argumentsText = rawArguments;
      if (resolvedName && isShellTool(resolvedName)) {
        debugChannelProgress(
          `[ARGS-BASH-REPLACE-COMPLETE] id=${cacheId} text=${sanitizeChannelProgressText(argumentsText, MAX_PROGRESS_DETAILS_LENGTH)}`,
        );
      }
    } else if (existing) {
      if (parseToolArguments(existing)) {
        argumentsText = existing;
        if (resolvedName && isShellTool(resolvedName)) {
          debugChannelProgress(
            `[ARGS-BASH-KEEP-EXISTING] id=${cacheId} text=${sanitizeChannelProgressText(argumentsText, MAX_PROGRESS_DETAILS_LENGTH)}`,
          );
        }
      } else {
        const accumulated = existing + rawArguments;
        toolCallArgumentsById.set(cacheId, accumulated);
        argumentsText = accumulated;
        if (resolvedName && isShellTool(resolvedName)) {
          debugChannelProgress(
            `[ARGS-BASH-ACCUMULATE] id=${cacheId} text=${sanitizeChannelProgressText(argumentsText, MAX_PROGRESS_DETAILS_LENGTH)}`,
          );
        }
      }
    } else {
      toolCallArgumentsById.set(cacheId, rawArguments);
      argumentsText = rawArguments;
      if (resolvedName && isShellTool(resolvedName)) {
        debugChannelProgress(
          `[ARGS-BASH-START] id=${cacheId} text=${sanitizeChannelProgressText(argumentsText, MAX_PROGRESS_DETAILS_LENGTH)}`,
        );
      }
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
    ...(resolvedDescriptionText
      ? {
          descriptionText: sanitizeChannelProgressText(
            resolvedDescriptionText,
            MAX_PROGRESS_DETAILS_LENGTH,
          ),
        }
      : {}),
  };
}

function extractToolCalls(delta: Record<string, unknown>): ToolCallSummary[] {
  const candidates: unknown[] = [];
  if (Array.isArray(delta.tool_calls)) {
    candidates.push(...delta.tool_calls);
  } else {
    candidates.push(delta.tool_calls);
  }
  if (Array.isArray(delta.toolCalls)) {
    candidates.push(...delta.toolCalls);
  } else {
    candidates.push(delta.toolCalls);
  }
  if (Array.isArray(delta.tools)) {
    candidates.push(...delta.tools);
  } else {
    candidates.push(delta.tools);
  }
  if (Array.isArray(delta.approvals)) {
    candidates.push(...delta.approvals);
  } else {
    candidates.push(delta.approvals);
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
        return [];
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
        // Try to get accumulated arguments for this tool call
        const accumulatedArgs = summary.id
          ? toolCallArgumentsById.get(summary.id)
          : undefined;
        if (accumulatedArgs && summary.id) {
          toolCallArgumentsById.delete(summary.id);
        }
        if (summary.id) {
          toolCallNamesById.delete(summary.id);
        }
        const toolWithAccumulatedArgs = accumulatedArgs
          ? { ...summary, argumentsText: accumulatedArgs }
          : summary;
        const toolTitle = formatToolProgressTitle(
          toolWithAccumulatedArgs,
          status,
        );
        const toolDetails = formatToolProgressDetails(toolWithAccumulatedArgs);
        updates.push(
          withRunId(
            {
              kind: "tool",
              state: status,
              message: status === "error" ? "Tool failed" : "Tool finished",
              ...(summary.id ? { toolCallId: summary.id } : {}),
              ...(summary.name ? { toolName: summary.name } : {}),
              ...(toolTitle ? { toolTitle } : {}),
              ...(toolDetails ? { toolDetails } : {}),
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
