import { writeFileSync } from "node:fs";
import {
  serveSubagentEvents,
  storeSubagentEvent,
} from "@/agent/subagent-events";
import {
  addProgressText,
  addToolCall,
  excerptProgressText as excerpt,
  PROGRESS_TEXT_CHARS,
  type ProgressText,
  updateSubagent,
} from "@/agent/subagent-state";
import type { SubagentResult } from "@/agent/subagents";
import {
  captureSecretRedactions,
  scrubSecretsDeep,
} from "@/tools/secret-substitution";
import type { SubagentEventRecord } from "@/types/subagent-protocol";
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

export const TASK_PROGRESS_TEXT_CHARS = PROGRESS_TEXT_CHARS;
export const TASK_PROGRESS_ARGS_CHARS = 200;
export const TASK_PROGRESS_MAX_LINES = 1_000;
export const TASK_EVENTS_MAX_BYTES = 256 * 1024 * 1024;

export function taskEventsFileFor(outputFile: string): string {
  return `${outputFile.replace(/\.(log|output)$/, "")}.jsonl`;
}

export type TaskEvent =
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_call_id: string;
      name?: string;
      is_error: boolean;
      output: string;
    }
  | { type: "text" | "reasoning" | "notification"; text: string };

interface TaskProgressLog {
  outputFile: string;
  eventsFile: string;
  lines: number;
  eventBytes: number;
  seq: number;
  seen: Set<string>;
  toolNames: Map<string, string>;
  lastText?: string;
  now: () => Date;
  redactions: Record<string, string>;
  serve: boolean;
}

const progressLogs = new Map<string, TaskProgressLog>();

function appendProgress(log: TaskProgressLog, entry: string, at: string) {
  if (log.lines >= TASK_PROGRESS_MAX_LINES) return;
  log.lines++;
  const line =
    log.lines === TASK_PROGRESS_MAX_LINES
      ? `[progress log reached ${TASK_PROGRESS_MAX_LINES} lines; further progress omitted; every event is in ${log.eventsFile}]`
      : `[${at}] ${entry}`;
  appendToOutputFile(log.outputFile, `${line}\n`);
}

function appendEvent(log: TaskProgressLog, record: SubagentEventRecord) {
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
      return null;
    case "notification": {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(event.text)?.[1];
      return `notification: ${excerpt(summary ?? event.text, 200)}`;
    }
  }
}

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
  } catch {}
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
    serve: false,
  });
}

export function serveTaskEvents(subagentId: string): void {
  const log = progressLogs.get(subagentId);
  if (!log) return;
  log.serve = true;
  serveSubagentEvents(subagentId);
  updateSubagent(subagentId, { eventSeq: log.seq });
}

export function closeTaskProgressLog(subagentId: string): void {
  progressLogs.delete(subagentId);
}

function isoOrUndefined(at: string | undefined): string | undefined {
  return at === undefined || Number.isNaN(Date.parse(at))
    ? undefined
    : new Date(at).toISOString();
}

export function recordTaskEvent(
  subagentId: string,
  event: TaskEvent,
  options: { at?: string; key?: string } = {},
): void {
  const log = progressLogs.get(subagentId);
  if (!log) return;
  event = scrubSecretsDeep(event, log.redactions);
  const keys = [
    options.key,
    event.type === "tool_call" ? `call:${event.id}` : undefined,
    event.type === "tool_result" ? `result:${event.tool_call_id}` : undefined,
  ].filter((value) => value !== undefined);
  if (keys.some((value) => log.seen.has(value))) return;
  const key = keys[0];
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
      if (key === undefined && event.text === log.lastText) return;
      log.lastText = event.text;
    }
  }
  for (const value of keys) log.seen.add(value);
  const at = isoOrUndefined(options.at) ?? log.now().toISOString();
  const record = { seq: ++log.seq, at, ...event };
  appendEvent(log, record);
  const line = readableLine(event);
  if (line !== null) appendProgress(log, line, at);
  if (log.serve) {
    storeSubagentEvent(subagentId, record);
    updateSubagent(subagentId, { eventSeq: log.seq });
  }
}

export function recordRemoteTaskEvent(
  subagentId: string,
  { seq, at, ...event }: SubagentEventRecord,
): void {
  recordTaskEvent(subagentId, event as TaskEvent, {
    at,
    key: `remote:${seq}`,
  });
}

export function recordMissedRemoteEvents(subagentId: string, missed: number) {
  const log = progressLogs.get(subagentId);
  if (!log || missed <= 0) return;
  const at = log.now().toISOString();
  appendEvent(log, { seq: ++log.seq, at, type: "events_missed", missed });
  appendProgress(log, `[${missed} earlier events were not received]`, at);
}

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

export function recordTaskProgressText(subagentId: string, text: string): void {
  recordTaskEvent(subagentId, { type: "text", text });
}

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
