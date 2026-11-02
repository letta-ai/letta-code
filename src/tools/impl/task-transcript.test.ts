import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capTaskEvent,
  REMOTE_EVENT_MAX_BYTES,
  readSubagentEvents,
} from "@/agent/subagent-events";
import {
  addProgressText,
  clearAllSubagents,
  getSnapshot,
  MAX_PROGRESS_TEXTS,
  registerSubagent,
} from "@/agent/subagent-state";
import {
  closeTaskProgressLog,
  externalWorkerProgressListeners,
  openTaskProgressLog,
  recordMissedRemoteEvents,
  recordRemoteTaskEvent,
  recordTaskEvent,
  recordTaskProgressRemoteText,
  recordTaskProgressText,
  recordTaskProgressToolCall,
  TASK_PROGRESS_MAX_LINES,
  taskEventsFileFor,
} from "./task-transcript";

const SUBAGENT = "subagent-progress-test";
const dirs: string[] = [];

function outputFile(options: { serve?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "task-progress-"));
  dirs.push(dir);
  const file = join(dir, "task.log");
  writeFileSync(file, "");
  openTaskProgressLog(SUBAGENT, file, { now: () => new Date(0), ...options });
  return file;
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function events(file: string): Array<Record<string, unknown>> {
  return lines(taskEventsFileFor(file)).map((line) => JSON.parse(line));
}

afterEach(() => {
  closeTaskProgressLog(SUBAGENT);
  clearAllSubagents();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("task progress log", () => {
  test("writes timestamped tool and text lines, once per tool-call ID", () => {
    const file = outputFile();
    const call = { id: "toolu_1", name: "Bash", args: '{"command":"ls"}' };
    recordTaskProgressText(SUBAGENT, "Looking\naround.");
    recordTaskProgressToolCall(SUBAGENT, call);
    recordTaskProgressToolCall(SUBAGENT, call);
    expect(lines(file)).toEqual([
      "[1970-01-01T00:00:00.000Z] text: Looking around.",
      '[1970-01-01T00:00:00.000Z] tool: Bash {"command":"ls"}',
    ]);
  });

  test("writes full text and arguments, without excerpting", () => {
    const file = outputFile();
    const long = "x".repeat(5_000);
    recordTaskProgressText(SUBAGENT, long);
    recordTaskProgressToolCall(SUBAGENT, {
      id: "t",
      name: "Write",
      // The display args are truncated; `input` carries the full arguments.
      args: `{"content":"${long.slice(0, 990)}…`,
      input: { file_path: "a.txt", content: long },
    });
    const written = lines(file);
    expect(written[0]).toBe(`[1970-01-01T00:00:00.000Z] text: ${long}`);
    expect(written[1]).toBe(
      `[1970-01-01T00:00:00.000Z] tool: Write {"file_path":"a.txt","content":"${long}"}`,
    );
  });

  test("skips blank and consecutive duplicate texts", () => {
    const file = outputFile();
    recordTaskProgressText(SUBAGENT, "Waiting.");
    recordTaskProgressText(SUBAGENT, "Waiting.");
    recordTaskProgressText(SUBAGENT, "   ");
    recordTaskProgressToolCall(SUBAGENT, { id: "t", name: "Bash", args: "" });
    // The same text after a tool call is new progress.
    recordTaskProgressText(SUBAGENT, "Waiting.");
    expect(lines(file)).toEqual([
      "[1970-01-01T00:00:00.000Z] text: Waiting.",
      "[1970-01-01T00:00:00.000Z] tool: Bash",
      "[1970-01-01T00:00:00.000Z] text: Waiting.",
    ]);
  });

  test("writes a short result line per tool call, and the line naming the error", () => {
    const file = outputFile();
    recordTaskProgressToolCall(SUBAGENT, {
      id: "c1",
      name: "Bash",
      args: '{"command":"bun test"}',
    });
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c1",
      is_error: true,
      output: "\nerror: expected 2, got 3\n  at sum.test.ts:4\n",
    });
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c1",
      is_error: false,
      output: "duplicate",
    });
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c2",
      name: "Read",
      is_error: false,
      output: "y".repeat(3_300),
    });
    // Verbose output: the failing line, not the first, is shown.
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c3",
      name: "Bash",
      is_error: true,
      output: "suite 3: collecting\nPASS a\nFAIL test_parse_hours\nExit code 1",
    });
    // With no line naming an error, the last line usually summarizes it.
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c4",
      name: "Bash",
      is_error: true,
      output: "compiling\nExit code 2\n",
    });
    expect(lines(file).slice(1)).toEqual([
      "[1970-01-01T00:00:00.000Z] result: Bash error, 45 B: error: expected 2, got 3",
      "[1970-01-01T00:00:00.000Z] result: Read ok, 3.2 KB",
      "[1970-01-01T00:00:00.000Z] result: Bash error, 60 B: FAIL test_parse_hours",
      "[1970-01-01T00:00:00.000Z] result: Bash error, 22 B: Exit code 2",
    ]);
  });

  test("the event log keeps every event in order, in full", () => {
    const file = outputFile();
    const output = `FAIL sum.test.ts\n${"z".repeat(50_000)}\nexpected 2, got 3`;
    recordTaskEvent(SUBAGENT, { type: "reasoning", text: "Run the tests." });
    recordTaskProgressToolCall(
      SUBAGENT,
      { id: "c1", name: "Bash", args: '{"command":"bun test"}' },
      "2026-11-01T10:00:00.000Z",
    );
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c1",
      is_error: true,
      output,
    });
    recordTaskProgressText(SUBAGENT, "One test fails.");
    expect(events(file)).toEqual([
      {
        seq: 1,
        at: "1970-01-01T00:00:00.000Z",
        type: "reasoning",
        text: "Run the tests.",
      },
      {
        seq: 2,
        at: "2026-11-01T10:00:00.000Z",
        type: "tool_call",
        id: "c1",
        name: "Bash",
        input: { command: "bun test" },
      },
      {
        seq: 3,
        at: "1970-01-01T00:00:00.000Z",
        type: "tool_result",
        tool_call_id: "c1",
        name: "Bash",
        is_error: true,
        output,
      },
      {
        seq: 4,
        at: "1970-01-01T00:00:00.000Z",
        type: "text",
        text: "One test fails.",
      },
    ]);
    // Reasoning stays out of the readable log.
    expect(lines(file).map((line) => line.slice(27, 33))).toEqual([
      "tool: ",
      "result",
      "text: ",
    ]);
  });

  test("external worker listeners record results, reasoning, and the transcript path", () => {
    registerSubagent(SUBAGENT, "claude-code", "Fix the bug");
    const file = outputFile();
    const listeners = externalWorkerProgressListeners(SUBAGENT);
    listeners.onTranscript("/home/u/.claude/projects/-w/s.jsonl");
    listeners.onToolCall({
      id: "toolu_1",
      name: "Bash",
      args: '{"command":"ls"}',
      input: { command: "ls" },
    });
    listeners.onToolResult({ id: "toolu_1", isError: false, output: "a\nb" });
    listeners.onReasoning("Thinking.");
    expect(events(file).map((event) => event.type)).toEqual([
      "session",
      "tool_call",
      "tool_result",
      "reasoning",
    ]);
    expect(lines(file)).toEqual([
      "[1970-01-01T00:00:00.000Z] session: native transcript /home/u/.claude/projects/-w/s.jsonl",
      '[1970-01-01T00:00:00.000Z] tool: Bash {"command":"ls"}',
      "[1970-01-01T00:00:00.000Z] result: Bash ok, 3 B",
    ]);
  });

  test("stops after the line cap, pointing at the event log", () => {
    const file = outputFile();
    for (let i = 0; i < TASK_PROGRESS_MAX_LINES + 50; i++)
      recordTaskProgressText(SUBAGENT, `step ${i}`);
    const written = lines(file);
    expect(written).toHaveLength(TASK_PROGRESS_MAX_LINES);
    expect(written.at(-1)).toContain(taskEventsFileFor(file));
    // The event log is not capped by lines.
    expect(events(file)).toHaveLength(TASK_PROGRESS_MAX_LINES + 50);
  });

  test("records nothing once the task's log is closed", () => {
    const file = outputFile();
    closeTaskProgressLog(SUBAGENT);
    recordTaskProgressText(SUBAGENT, "late");
    recordTaskProgressToolCall(SUBAGENT, { id: "t", name: "Bash", args: "" });
    expect(lines(file)).toEqual([]);
    expect(events(file)).toEqual([]);
  });

  test("the event log sits next to the output file", () => {
    expect(taskEventsFileFor("/tmp/x/task_3.log")).toBe("/tmp/x/task_3.jsonl");
    expect(taskEventsFileFor("C:\\Temp\\task_3.log")).toBe(
      "C:\\Temp\\task_3.jsonl",
    );
  });
});

describe("remote worker events", () => {
  test("a served task keeps each event for its remote parent, announcing the seq", () => {
    registerSubagent(SUBAGENT, "claude-code", "Fix the bug");
    outputFile({ serve: true });
    const seq = () =>
      getSnapshot().agents.find((agent) => agent.id === SUBAGENT)?.eventSeq;
    expect(seq()).toBe(0);
    recordTaskProgressToolCall(SUBAGENT, {
      id: "c1",
      name: "Bash",
      args: "{}",
      input: { command: "ls" },
    });
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c1",
      is_error: false,
      output: "o".repeat(REMOTE_EVENT_MAX_BYTES * 2),
    });
    recordTaskProgressText(SUBAGENT, "Done.");
    expect(seq()).toBe(3);

    const first = readSubagentEvents(SUBAGENT, 0, 1);
    // A page holds at least one event, however small the budget.
    expect(first?.events.map((event) => event.seq)).toEqual([1]);
    expect(first?.has_more).toBe(true);
    const rest = readSubagentEvents(SUBAGENT, first?.next_seq ?? 0);
    expect(rest?.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(rest?.has_more).toBe(false);
    expect(rest?.next_seq).toBe(3);
    // An oversized event is cut with an explicit marker.
    const result = rest?.events[0];
    expect(result?.truncated_bytes).toBeGreaterThan(REMOTE_EVENT_MAX_BYTES);
    expect(String(result?.output)).toMatch(/\n\[truncated \d+ bytes\]$/);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      REMOTE_EVENT_MAX_BYTES,
    );
  });

  test("an unserved task keeps nothing for remote readers", () => {
    registerSubagent(SUBAGENT, "claude-code", "Fix the bug");
    outputFile();
    recordTaskProgressText(SUBAGENT, "Done.");
    expect(readSubagentEvents(SUBAGENT, 0)).toBeUndefined();
  });

  test("capTaskEvent leaves small events alone", () => {
    const event = { seq: 1, at: "t", type: "text", text: "hi" };
    expect(capTaskEvent(event)).toBe(event);
  });

  test("the parent writes each remote event once, at the worker's time", () => {
    const file = outputFile();
    const call = {
      seq: 1,
      at: "2026-11-01T10:00:00.000Z",
      type: "tool_call",
      id: "c1",
      name: "Bash",
      input: { command: "bun test" },
    };
    recordRemoteTaskEvent(SUBAGENT, call);
    recordRemoteTaskEvent(SUBAGENT, call);
    // The same call through an older snapshot field is not written again.
    recordTaskProgressToolCall(SUBAGENT, { id: "c1", name: "Bash", args: "" });
    recordMissedRemoteEvents(SUBAGENT, 4);
    recordRemoteTaskEvent(SUBAGENT, {
      seq: 7,
      at: "2026-11-01T10:00:05.000Z",
      type: "tool_result",
      tool_call_id: "c1",
      is_error: false,
      output: "ok",
      truncated_bytes: 10,
    });
    expect(lines(file)).toEqual([
      '[2026-11-01T10:00:00.000Z] tool: Bash {"command":"bun test"}',
      "[1970-01-01T00:00:00.000Z] [4 earlier events were not received]",
      "[2026-11-01T10:00:05.000Z] result: Bash ok, 2 B",
    ]);
    expect(events(file).map((event) => event.type)).toEqual([
      "tool_call",
      "status",
      "tool_result",
    ]);
    expect(events(file)[2]?.truncated_bytes).toBe(10);
  });
});

describe("remote worker progress texts (older computers)", () => {
  test("worker state keeps the latest capped texts with stable IDs", () => {
    registerSubagent(SUBAGENT, "claude-code", "Fix the bug");
    const at = () => new Date(0);
    addProgressText(SUBAGENT, "first", at);
    addProgressText(SUBAGENT, "first", at);
    addProgressText(SUBAGENT, " ", at);
    addProgressText(SUBAGENT, "y".repeat(5_000), at);
    for (let i = 0; i < MAX_PROGRESS_TEXTS; i++)
      addProgressText(SUBAGENT, `step ${i}`, at);
    const texts =
      getSnapshot().agents.find((agent) => agent.id === SUBAGENT)
        ?.progressTexts ?? [];
    expect(texts).toHaveLength(MAX_PROGRESS_TEXTS);
    // Two texts were recorded before the steps, so IDs keep counting past them.
    expect(texts[0]).toEqual({
      id: "text-3",
      at: "1970-01-01T00:00:00.000Z",
      text: "step 0",
    });
    expect(texts.at(-1)?.id).toBe(`text-${MAX_PROGRESS_TEXTS + 2}`);

    registerSubagent("capped", "claude-code", "Cap");
    addProgressText("capped", "y".repeat(5_000), at);
    const [capped] =
      getSnapshot().agents.find((agent) => agent.id === "capped")
        ?.progressTexts ?? [];
    expect(capped?.text).toBe(`${"y".repeat(300)}…`);
  });

  test("the parent log writes each remote text once at the worker's time", () => {
    const file = outputFile();
    const entry = { id: "text-1", at: "2026-11-01T21:14:40.833Z", text: "Hi" };
    recordTaskProgressRemoteText(SUBAGENT, entry);
    recordTaskProgressRemoteText(SUBAGENT, entry);
    recordTaskProgressRemoteText(SUBAGENT, {
      id: "text-2",
      at: "",
      text: "Ok",
    });
    expect(lines(file)).toEqual([
      "[2026-11-01T21:14:40.833Z] text: Hi",
      "[1970-01-01T00:00:00.000Z] text: Ok",
    ]);
  });
});
