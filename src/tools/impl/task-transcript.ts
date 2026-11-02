// Output-file transcript lines and result headers shared by Agent task paths.

import { writeFileSync } from "node:fs";
import {
  serveSubagentEvents,
  storeSubagentEvent,
  type TaskEventRecord,
} from "@/agent/subagent-events";
import {
  addProgressText,
  addToolCall,
  type ProgressText,
  updateSubagent,
} from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
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

/** Start a task's output file, naming the event log written next to it. */
export function writeTaskTranscriptStart(
  outputFile: string,
  description: string,
  subagentType: string,
): void {
  const events = `[event log: ${taskEventsFileFor(outputFile)} (full tool arguments and results, one JSON object per line)]\n`;
  appendToOutputFile(
    outputFile,
    `[Task started: ${description}]\n[subagent_type: ${subagentType}]\n${events}\n`,
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

/** Readable progress lines written per task; a safety valve, not an excerpt. */
export const TASK_PROGRESS_MAX_LINES = 20_000;
/** Event-log bytes written per task; a safety valve for runaway output. */
export const TASK_EVENTS_MAX_BYTES = 256 * 1024 * 1024;

/** The full event log written next to a task's output file. */
export function taskEventsFileFor(outputFile: string): string {
  return `${outputFile.replace(/\.(log|output)$/, "")}.jsonl`;
}

/** An event in a task's log, before it is numbered and stamped. */
export type TaskEvent =
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_call_id: string;
      name?: string;
      is_error: boolean;
      output: string;
    }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** A background-task notification the worker received (a new turn's input). */
  | { type: "notification"; text: string }
  | {
      type: "session";
      agent_id?: string;
      conversation_id?: string;
      native_transcript?: string;
    };

interface TaskProgressLog {
  outputFile: string;
  eventsFile: string;
  lines: number;
  eventBytes: number;
  seq: number;
  /** Dedupe keys already written (tool-call IDs, remote event IDs, …). */
  seen: Set<string>;
  /** Tool names by call ID, so results can name their tool. */
  toolNames: Map<string, string>;
  lastText?: string;
  now: () => Date;
  /** Keep events for a parent on another computer. */
  serve: boolean;
}

const progressLogs = new Map<string, TaskProgressLog>();

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The line most likely to name an error: the first that mentions one, else
 * the last non-empty line (where commands usually summarize a failure).
 */
function errorLine(output: string): string {
  const lines = output.split("\n").filter((line) => line.trim());
  const named = lines.find((line) =>
    /\b(error|fail(ed|ure)?|exception|assert\w*|panic|traceback)\b/i.test(line),
  );
  return oneLine(named ?? lines.at(-1) ?? "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tool arguments as one line of JSON, without truncation. */
function formatInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input.replace(/\r?\n/g, "\\n");
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

function readableLine(log: TaskProgressLog, event: TaskEvent): string | null {
  switch (event.type) {
    case "tool_call": {
      const args = formatInput(event.input);
      return `tool: ${event.name}${args ? ` ${args}` : ""}`;
    }
    case "tool_result": {
      const name =
        event.name ?? log.toolNames.get(event.tool_call_id) ?? "tool";
      const size = formatBytes(Buffer.byteLength(event.output, "utf8"));
      const firstLine = event.is_error ? errorLine(event.output) : "";
      return `result: ${name} ${event.is_error ? "error" : "ok"}, ${size}${
        firstLine ? `: ${firstLine.slice(0, 200)}` : ""
      }`;
    }
    case "text":
      return `text: ${oneLine(event.text)}`;
    case "reasoning":
      // Reasoning is in the event log only; it is too noisy to tail.
      return null;
    case "notification": {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(event.text)?.[1];
      return `notification: ${oneLine(summary ?? event.text).slice(0, 200)}`;
    }
    case "session": {
      const parts = [
        event.agent_id ? `agent ${event.agent_id}` : "",
        event.conversation_id ? `conversation ${event.conversation_id}` : "",
        event.native_transcript
          ? `native transcript ${event.native_transcript}`
          : "",
      ].filter(Boolean);
      return parts.length ? `session: ${parts.join(", ")}` : null;
    }
  }
}

function appendLine(log: TaskProgressLog, line: string, at: string): void {
  if (log.lines >= TASK_PROGRESS_MAX_LINES) return;
  log.lines++;
  // The last line the cap allows says where the full record continues.
  const text =
    log.lines === TASK_PROGRESS_MAX_LINES
      ? `[progress log reached ${TASK_PROGRESS_MAX_LINES} lines; the rest is in ${log.eventsFile}]`
      : `[${at}] ${line}`;
  appendToOutputFile(log.outputFile, `${text}\n`);
}

function appendEvent(log: TaskProgressLog, record: TaskEventRecord): void {
  if (log.eventBytes >= TASK_EVENTS_MAX_BYTES) return;
  let json = JSON.stringify(record);
  if (log.eventBytes + json.length >= TASK_EVENTS_MAX_BYTES) {
    json = JSON.stringify({
      seq: record.seq,
      at: record.at,
      type: "status",
      status: "event_log_full",
      detail: `The event log reached ${formatBytes(TASK_EVENTS_MAX_BYTES)}; later events are not recorded.`,
    });
    log.eventBytes = TASK_EVENTS_MAX_BYTES;
  } else {
    log.eventBytes += json.length + 1;
  }
  appendToOutputFile(log.eventsFile, `${json}\n`);
}

/**
 * Start recording a task's events: a full JSONL event log next to the output
 * file, and one readable line per event in the output file itself, between
 * `[Task started…]` and the final result. With `serve`, events are also kept
 * for a parent on another computer to read.
 */
export function openTaskProgressLog(
  subagentId: string,
  outputFile: string,
  options: { now?: () => Date; serve?: boolean } = {},
): string {
  const eventsFile = taskEventsFileFor(outputFile);
  try {
    writeFileSync(eventsFile, "", { mode: 0o600, flag: "a" });
  } catch {
    // The readable log still works; appends to the event log will no-op.
  }
  progressLogs.set(subagentId, {
    outputFile,
    eventsFile,
    lines: 0,
    eventBytes: 0,
    seq: 0,
    seen: new Set(),
    toolNames: new Map(),
    now: options.now ?? (() => new Date()),
    serve: options.serve === true,
  });
  if (options.serve) {
    serveSubagentEvents(subagentId);
    updateSubagent(subagentId, { eventSeq: 0 });
  }
  return eventsFile;
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

function defaultKey(event: TaskEvent): string | undefined {
  if (event.type === "tool_call") return `call:${event.id}`;
  if (event.type === "tool_result") return `result:${event.tool_call_id}`;
  return undefined;
}

/**
 * Record one event of a running task: append it in full to the event log and
 * as one readable line to the output file. Tool calls and results are written
 * once per tool-call ID; `key` dedupes other events (e.g. a remote event ID).
 * `at` is when the worker produced the event; it defaults to now.
 */
export function recordTaskEvent(
  subagentId: string,
  event: TaskEvent,
  options: { at?: string; key?: string } = {},
): void {
  const log = progressLogs.get(subagentId);
  if (!log) return;
  // A remote event carries its own key; its tool-call ID still dedupes it
  // against the same call reported through an older snapshot field.
  const keys = [options.key, defaultKey(event)].filter(
    (value): value is string => value !== undefined,
  );
  if (keys.some((value) => log.seen.has(value))) return;
  for (const value of keys) log.seen.add(value);
  const key = keys[0];
  if (
    event.type === "text" ||
    event.type === "reasoning" ||
    event.type === "notification"
  ) {
    if (!event.text.trim()) return;
  }
  if (event.type === "text") {
    // Some workers repeat a message; skip an unkeyed back-to-back repeat.
    if (key === undefined && event.text === log.lastText) return;
    log.lastText = event.text;
  } else if (event.type === "tool_call") {
    log.lastText = undefined;
    log.toolNames.set(event.id, event.name);
  }
  if (event.type === "tool_result" && event.name === undefined) {
    // Name the tool, so the event log can be searched by tool name.
    const name = log.toolNames.get(event.tool_call_id);
    if (name) event = { ...event, name };
  }
  const at = isoOrUndefined(options.at) ?? log.now().toISOString();
  log.seq++;
  const record = { seq: log.seq, at, ...event } as TaskEventRecord;
  appendEvent(log, record);
  const line = readableLine(log, event);
  if (line !== null) appendLine(log, line, at);
  if (log.serve) {
    storeSubagentEvent(subagentId, record);
    updateSubagent(subagentId, { eventSeq: log.seq });
  }
}

/**
 * Record an event read from a parent on another computer: it already has the
 * worker's seq and time, and is written once per remote seq.
 */
export function recordRemoteTaskEvent(
  subagentId: string,
  record: TaskEventRecord,
): void {
  const { seq, at, type, ...rest } = record;
  if (typeof type !== "string") return;
  recordTaskEvent(subagentId, { type, ...rest } as TaskEvent, {
    at,
    key: `remote:${seq}`,
  });
}

/** Note in both logs that remote events were dropped before they were read. */
export function recordMissedRemoteEvents(
  subagentId: string,
  missed: number,
): void {
  const log = progressLogs.get(subagentId);
  if (!log || missed <= 0) return;
  const at = log.now().toISOString();
  log.seq++;
  appendEvent(log, {
    seq: log.seq,
    at,
    type: "status",
    status: "events_missed",
    detail: `${missed} earlier events were no longer kept on the worker's computer.`,
  });
  appendLine(log, `[${missed} earlier events were not received]`, at);
}

/**
 * Append a tool call (legacy entry point: a display tool call whose `input`,
 * when present, carries the full arguments).
 */
export function recordTaskProgressToolCall(
  subagentId: string,
  call: ExternalToolCall,
  at?: string,
): void {
  recordTaskEvent(
    subagentId,
    {
      type: "tool_call",
      id: call.id,
      name: call.name,
      input: call.input !== undefined ? call.input : parseToolInput(call.args),
    },
    { at },
  );
}

/** Append assistant text, skipping blanks and consecutive repeats. */
export function recordTaskProgressText(subagentId: string, text: string): void {
  recordTaskEvent(subagentId, { type: "text", text });
}

/**
 * Append a remote worker's text from an older computer's snapshot, once per
 * ID, stamped with the time the worker emitted it.
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
        ...(result.name ? { name: result.name } : {}),
        is_error: result.isError,
        output: result.output,
      }),
    onReasoning: (text) =>
      recordTaskEvent(subagentId, { type: "reasoning", text }),
    onTranscript: (path) =>
      recordTaskEvent(
        subagentId,
        { type: "session", native_transcript: path },
        { key: `transcript:${path}` },
      ),
  };
}
