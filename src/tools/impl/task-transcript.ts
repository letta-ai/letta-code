// Output-file transcript lines and result headers shared by Agent task paths.

import { writeFileSync } from "node:fs";
import {
  addProgressText,
  addToolCall,
  excerptProgressText as excerpt,
  PROGRESS_TEXT_CHARS,
  type ProgressText,
} from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import {
  captureSecretRedactions,
  scrubSecretsDeep,
} from "@/tools/secret-substitution";
import {
  type ExternalToolCall,
  type ExternalWorkerListeners,
  parseToolInput,
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
export const TASK_PROGRESS_TEXT_CHARS = PROGRESS_TEXT_CHARS;
/** Longest tool-argument excerpt written per progress line. */
export const TASK_PROGRESS_ARGS_CHARS = 200;
/** Progress lines written per task, including the final omission notice. */
export const TASK_PROGRESS_MAX_LINES = 1_000;
/** Event-log bytes written per task; a safety valve for runaway output. */
export const TASK_EVENTS_MAX_BYTES = 256 * 1024 * 1024;

/** The full event log written next to a task's output file. */
export function taskEventsFileFor(outputFile: string): string {
  return `${outputFile.replace(/\.(log|output)$/, "")}.jsonl`;
}

/** An event of a running task, before it is numbered and stamped. */
export type TaskEvent =
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_call_id: string;
      name?: string;
      is_error: boolean;
      output: string;
    }
  /** `notification`: a background command's completion notice, a new turn. */
  | { type: "text" | "reasoning" | "notification"; text: string };

interface TaskProgressLog {
  outputFile: string;
  eventsFile: string;
  lines: number;
  eventBytes: number;
  seq: number;
  /** Dedupe keys already written (tool-call IDs, remote message IDs, …). */
  seen: Set<string>;
  /** Tool names by call ID, so results can name their tool. */
  toolNames: Map<string, string>;
  lastText?: string;
  now: () => Date;
  /** Secret values scrubbed from every event before it is written. */
  redactions: Record<string, string>;
}

const progressLogs = new Map<string, TaskProgressLog>();

function appendProgress(log: TaskProgressLog, entry: string, at: string) {
  if (log.lines >= TASK_PROGRESS_MAX_LINES) return;
  log.lines++;
  // The last line the cap allows is a notice that the log stops here.
  const line =
    log.lines === TASK_PROGRESS_MAX_LINES
      ? `[progress log reached ${TASK_PROGRESS_MAX_LINES} lines; further progress omitted; every event is in ${log.eventsFile}]`
      : `[${at}] ${entry}`;
  appendToOutputFile(log.outputFile, `${line}\n`);
}

function appendEvent(log: TaskProgressLog, record: object): void {
  if (log.eventBytes >= TASK_EVENTS_MAX_BYTES) return;
  let json = JSON.stringify(record);
  log.eventBytes += json.length + 1;
  if (log.eventBytes >= TASK_EVENTS_MAX_BYTES) {
    json = JSON.stringify({ type: "status", status: "event_log_full" });
  }
  appendToOutputFile(log.eventsFile, `${json}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The output line most likely to name an error: the first that mentions one,
 * else the last non-empty line (where commands usually summarize a failure).
 */
function errorLine(output: string): string {
  const lines = output.split("\n").filter((line) => line.trim());
  const named = lines.find((line) =>
    /\b(error|fail(ed|ure)?|exception|assert\w*|panic|traceback)\b/i.test(line),
  );
  return excerpt(named ?? lines.at(-1) ?? "", 200);
}

function readableLine(event: TaskEvent): string | null {
  switch (event.type) {
    case "tool_call": {
      const json =
        typeof event.input === "string"
          ? event.input
          : (JSON.stringify(event.input) ?? "");
      const args = excerpt(json, TASK_PROGRESS_ARGS_CHARS);
      return `tool: ${event.name}${args ? ` ${args}` : ""}`;
    }
    case "tool_result": {
      const size = formatBytes(Buffer.byteLength(event.output, "utf8"));
      const error = event.is_error ? errorLine(event.output) : "";
      return `result: ${event.name ?? "tool"} ${event.is_error ? "error" : "ok"}, ${size}${error ? `: ${error}` : ""}`;
    }
    case "text":
      return `text: ${excerpt(event.text, TASK_PROGRESS_TEXT_CHARS)}`;
    case "reasoning":
      // Reasoning is in the event log only; it is too noisy to tail.
      return null;
    case "notification": {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(event.text)?.[1];
      return `notification: ${excerpt(summary ?? event.text, 200)}`;
    }
  }
}

/**
 * Start recording live worker progress into a task's output file, between
 * `[Task started…]` and the final result: one readable line per tool call,
 * tool result, and message. Every event also goes, in full, to a JSONL event
 * log next to the output file. The runtime credentials and the parent
 * agent's vault values (or `redactions`, in tests) are scrubbed from each
 * event first.
 */
export function openTaskProgressLog(
  subagentId: string,
  outputFile: string,
  parentAgentId?: string,
  {
    now = () => new Date(),
    redactions = captureSecretRedactions(parentAgentId),
  }: { now?: () => Date; redactions?: Record<string, string> } = {},
): void {
  const eventsFile = taskEventsFileFor(outputFile);
  try {
    writeFileSync(eventsFile, "", { mode: 0o600, flag: "a" });
  } catch {
    // The readable log still works; event-log appends will no-op.
  }
  progressLogs.set(subagentId, {
    outputFile,
    eventsFile,
    lines: 0,
    eventBytes: 0,
    seq: 0,
    seen: new Set(),
    toolNames: new Map(),
    now,
    redactions,
  });
}

/** Stop recording progress, so nothing lands after the final result. */
export function closeTaskProgressLog(subagentId: string): void {
  progressLogs.delete(subagentId);
}

function isoOrUndefined(at: string | undefined): string | undefined {
  return at === undefined || Number.isNaN(Date.parse(at))
    ? undefined
    : new Date(at).toISOString();
}

/**
 * Record one event of a running task: in full to the event log, and as one
 * readable line to the output file. Tool calls and results are written once
 * per tool-call ID; `key` dedupes other events (e.g. a remote message ID).
 * `at` is when the worker produced the event; it defaults to now.
 */
export function recordTaskEvent(
  subagentId: string,
  event: TaskEvent,
  options: { at?: string; key?: string } = {},
): void {
  const log = progressLogs.get(subagentId);
  if (!log) return;
  // Scrub raw values before anything is serialized or excerpted.
  event = scrubSecretsDeep(event, log.redactions);
  const key =
    options.key ??
    (event.type === "tool_call"
      ? `call:${event.id}`
      : event.type === "tool_result"
        ? `result:${event.tool_call_id}`
        : undefined);
  if (key !== undefined && log.seen.has(key)) return;
  if (event.type === "tool_call") {
    log.lastText = undefined;
    log.toolNames.set(event.id, event.name);
  } else if (event.type === "tool_result") {
    event = {
      ...event,
      name: event.name ?? log.toolNames.get(event.tool_call_id),
    };
  } else {
    if (!event.text.trim()) return;
    if (event.type === "text") {
      // Some workers repeat a message; skip an unkeyed back-to-back repeat.
      if (key === undefined && event.text === log.lastText) return;
      log.lastText = event.text;
    }
  }
  if (key !== undefined) log.seen.add(key);
  const at = isoOrUndefined(options.at) ?? log.now().toISOString();
  appendEvent(log, { seq: ++log.seq, at, ...event });
  const line = readableLine(event);
  if (line !== null) appendProgress(log, line, at);
}

/**
 * Append a tool call, stamped with `at` (when the worker made the call) if
 * given. `input`, when present, carries the full arguments.
 */
export function recordTaskProgressToolCall(
  subagentId: string,
  call: ExternalToolCall,
  at?: string,
): void {
  const input =
    call.input !== undefined ? call.input : parseToolInput(call.args);
  recordTaskEvent(
    subagentId,
    { type: "tool_call", id: call.id, name: call.name, input },
    { at },
  );
}

/** Append assistant text, skipping blanks and consecutive repeats. */
export function recordTaskProgressText(subagentId: string, text: string): void {
  recordTaskEvent(subagentId, { type: "text", text });
}

/**
 * Append a remote worker's text once per ID, stamped with the time the
 * worker emitted it.
 */
export function recordTaskProgressRemoteText(
  subagentId: string,
  entry: ProgressText,
): void {
  recordTaskEvent(
    subagentId,
    { type: "text", text: entry.text },
    { at: entry.at, key: `text:${entry.id}` },
  );
}

/**
 * Progress listeners for an external worker: tool calls and assistant text
 * update the subagent state (the live display, and the snapshots a parent on
 * another computer reads), and every event goes to the task's logs.
 */
export function externalWorkerProgressListeners(
  subagentId: string,
): Required<ExternalWorkerListeners> {
  return {
    onToolCall: (call) => {
      addToolCall(subagentId, call.id, call.name, call.args);
      recordTaskProgressToolCall(subagentId, call);
    },
    onText: (text) => {
      addProgressText(subagentId, text);
      recordTaskProgressText(subagentId, text);
    },
    onToolResult: (result) =>
      recordTaskEvent(subagentId, {
        type: "tool_result",
        tool_call_id: result.id,
        name: result.name,
        is_error: result.isError,
        output: result.output,
      }),
    onReasoning: (text) =>
      recordTaskEvent(subagentId, { type: "reasoning", text }),
  };
}
