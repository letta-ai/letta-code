// Output-file transcript lines and result headers shared by Agent task paths.

import { addToolCall } from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import type {
  ExternalTextListener,
  ExternalToolCall,
  ExternalToolCallListener,
} from "./external-tool-call";
import { appendToOutputFile } from "./process_manager.js";

export function buildTaskResultHeader(
  subagentType: string,
  subagentId: string,
  result?: Pick<
    SubagentResult,
    "agentId" | "conversationId" | "runtimeSessionId"
  >,
  status?: "success" | "error",
): string {
  return [
    `subagent_type=${subagentType}`,
    `subagent_id=${subagentId}`,
    status ? `subagent_status=${status}` : undefined,
    result?.agentId ? `agent_id=${result.agentId}` : undefined,
    result?.conversationId
      ? `conversation_id=${result.conversationId}`
      : undefined,
    result?.runtimeSessionId
      ? `runtime_session_id=${result.runtimeSessionId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function writeTaskTranscriptStart(
  outputFile: string,
  description: string,
  subagentType: string,
): void {
  appendToOutputFile(
    outputFile,
    `[Task started: ${description}]\n[subagent_type: ${subagentType}]\n\n`,
  );
}

export function writeTaskTranscriptResult(
  outputFile: string,
  result: SubagentResult,
  header: string,
  reportAlreadyWritten = false,
): void {
  if (result.success) {
    const report = reportAlreadyWritten ? "" : `${result.report}\n\n`;
    appendToOutputFile(outputFile, `${header}\n\n${report}[Task completed]\n`);
    return;
  }

  appendToOutputFile(
    outputFile,
    `${header ? `${header}\n\n` : ""}[error] ${result.error || "Subagent execution failed"}\n\n[Task failed]\n`,
  );
}

/** Longest `text:` excerpt written per progress line. */
export const TASK_PROGRESS_TEXT_CHARS = 300;
/** Longest tool-argument excerpt written per progress line. */
export const TASK_PROGRESS_ARGS_CHARS = 200;
/** Progress lines written per task, including the final omission notice. */
export const TASK_PROGRESS_MAX_LINES = 1_000;

interface TaskProgressLog {
  outputFile: string;
  lines: number;
  seenToolCallIds: Set<string>;
  lastText?: string;
  now: () => Date;
}

const progressLogs = new Map<string, TaskProgressLog>();

/** Collapse whitespace and cap a progress excerpt to one short line. */
function excerpt(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function appendProgress(log: TaskProgressLog, entry: string): void {
  if (log.lines >= TASK_PROGRESS_MAX_LINES) return;
  log.lines++;
  // The last line the cap allows is a notice that the log stops here.
  const line =
    log.lines === TASK_PROGRESS_MAX_LINES
      ? `[progress log reached ${TASK_PROGRESS_MAX_LINES} lines; further progress omitted]`
      : `[${log.now().toISOString()}] ${entry}`;
  appendToOutputFile(log.outputFile, `${line}\n`);
}

/**
 * Start recording live worker progress (tool calls and assistant text) into a
 * task's output file, between `[Task started…]` and the final result.
 */
export function openTaskProgressLog(
  subagentId: string,
  outputFile: string,
  now: () => Date = () => new Date(),
): void {
  progressLogs.set(subagentId, {
    outputFile,
    lines: 0,
    seenToolCallIds: new Set(),
    now,
  });
}

/** Stop recording progress, so nothing lands after the final result. */
export function closeTaskProgressLog(subagentId: string): void {
  progressLogs.delete(subagentId);
}

/** Append `tool: <name> <args>` once per tool-call ID. */
export function recordTaskProgressToolCall(
  subagentId: string,
  call: ExternalToolCall,
): void {
  const log = progressLogs.get(subagentId);
  if (!log || log.seenToolCallIds.has(call.id)) return;
  log.seenToolCallIds.add(call.id);
  log.lastText = undefined;
  const args = excerpt(call.args, TASK_PROGRESS_ARGS_CHARS);
  appendProgress(log, `tool: ${call.name}${args ? ` ${args}` : ""}`);
}

/** Append `text: <excerpt>`, skipping blanks and consecutive repeats. */
export function recordTaskProgressText(subagentId: string, text: string): void {
  const log = progressLogs.get(subagentId);
  if (!log) return;
  const line = excerpt(text, TASK_PROGRESS_TEXT_CHARS);
  if (!line || line === log.lastText) return;
  log.lastText = line;
  appendProgress(log, `text: ${line}`);
}

/**
 * Progress listeners for an external worker: each tool call updates the live
 * subagent display and, with assistant text, the task's output file.
 */
export function externalWorkerProgressListeners(subagentId: string): {
  onToolCall: ExternalToolCallListener;
  onText: ExternalTextListener;
} {
  return {
    onToolCall: (call) => {
      addToolCall(subagentId, call.id, call.name, call.args);
      recordTaskProgressToolCall(subagentId, call);
    },
    onText: (text) => recordTaskProgressText(subagentId, text),
  };
}
