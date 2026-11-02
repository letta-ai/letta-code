import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  recordTaskEvent,
  recordTaskProgressRemoteText,
  recordTaskProgressText,
  recordTaskProgressToolCall,
  TASK_PROGRESS_MAX_LINES,
  TASK_PROGRESS_TEXT_CHARS,
  taskEventsFileFor,
} from "./task-transcript";

const SUBAGENT = "subagent-progress-test";
const dirs: string[] = [];

function outputFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-progress-"));
  dirs.push(dir);
  const file = join(dir, "task.log");
  writeFileSync(file, "");
  openTaskProgressLog(SUBAGENT, file, () => new Date(0));
  return file;
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
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

  test("caps text, skips blank and consecutive duplicate texts", () => {
    const file = outputFile();
    recordTaskProgressText(SUBAGENT, "Waiting.");
    recordTaskProgressText(SUBAGENT, "Waiting.");
    recordTaskProgressText(SUBAGENT, "   ");
    recordTaskProgressText(SUBAGENT, "x".repeat(5_000));
    recordTaskProgressToolCall(SUBAGENT, { id: "t", name: "Bash", args: "" });
    // The same text after a tool call is new progress.
    recordTaskProgressText(SUBAGENT, "Waiting.");
    const written = lines(file);
    expect(written).toHaveLength(4);
    expect(written[1]).toBe(
      `[1970-01-01T00:00:00.000Z] text: ${"x".repeat(TASK_PROGRESS_TEXT_CHARS)}…`,
    );
    expect(written[2]).toBe("[1970-01-01T00:00:00.000Z] tool: Bash");
    expect(written[3]).toBe("[1970-01-01T00:00:00.000Z] text: Waiting.");
  });

  test("stops after the line cap with one notice", () => {
    const file = outputFile();
    for (let i = 0; i < TASK_PROGRESS_MAX_LINES + 50; i++)
      recordTaskProgressText(SUBAGENT, `step ${i}`);
    const written = lines(file);
    expect(written).toHaveLength(TASK_PROGRESS_MAX_LINES);
    expect(written.at(-1)).toContain("further progress omitted");
  });

  test("records nothing once the task's log is closed", () => {
    const file = outputFile();
    closeTaskProgressLog(SUBAGENT);
    recordTaskProgressText(SUBAGENT, "late");
    recordTaskProgressToolCall(SUBAGENT, { id: "t", name: "Bash", args: "" });
    expect(lines(file)).toEqual([]);
  });
});

describe("task event log", () => {
  test("keeps every event in full next to a one-line-per-result output file", () => {
    const file = outputFile();
    const worker = externalWorkerProgressListeners(SUBAGENT);
    const command = `pytest ${"-k x ".repeat(100)}`;
    const output = `${"PASS test_ok\n".repeat(2_000)}FAIL test_parse_hours\nAssertionError: 6000 != 5400\n1 failed`;
    worker.onToolCall({
      id: "c1",
      name: "Bash",
      args: "{}",
      input: { command },
    });
    worker.onReasoning("Suite 3 may be slow.");
    worker.onToolResult({ id: "c1", isError: true, output });
    worker.onToolResult({ id: "c1", isError: true, output: "replayed" });

    expect(lines(file).slice(1)).toEqual([
      "[1970-01-01T00:00:00.000Z] result: Bash error, 25.4 KB: FAIL test_parse_hours",
    ]);
    const events = lines(taskEventsFileFor(file)).map((line) =>
      JSON.parse(line),
    );
    const at = "1970-01-01T00:00:00.000Z";
    expect(events).toEqual([
      {
        seq: 1,
        at,
        type: "tool_call",
        id: "c1",
        name: "Bash",
        input: { command },
      },
      { seq: 2, at, type: "reasoning", text: "Suite 3 may be slow." },
      {
        seq: 3,
        at,
        type: "tool_result",
        tool_call_id: "c1",
        name: "Bash",
        is_error: true,
        output,
      },
    ]);
  });
});

describe("task log secret scrubbing", () => {
  test.each([
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----",
    'p@ss"word\\with\\slashes"9f3k',
  ])("scrubs %j from the event log and output file", (secret) => {
    const dir = mkdtempSync(join(tmpdir(), "task-secrets-"));
    dirs.push(dir);
    const file = join(dir, "task.log");
    writeFileSync(file, "");
    openTaskProgressLog(SUBAGENT, file, () => new Date(0), {
      DEPLOY_KEY: secret,
    });
    // Letta and remote events arrive without any worker-side scrubbing.
    recordTaskProgressToolCall(SUBAGENT, {
      id: "c1",
      name: "Bash",
      args: JSON.stringify({ command: `cat ${secret}` }),
    });
    recordTaskEvent(SUBAGENT, {
      type: "tool_result",
      tool_call_id: "c1",
      is_error: true,
      output: `error: bad key ${secret}`,
    });
    recordTaskEvent(SUBAGENT, { type: "reasoning", text: secret });
    const tail = secret.slice(-16);
    for (const written of [
      readFileSync(file, "utf8"),
      readFileSync(taskEventsFileFor(file), "utf8"),
    ]) {
      expect(written).toContain("DEPLOY_KEY=<REDACTED>");
      expect(written).not.toContain(tail);
      expect(written).not.toContain(JSON.stringify(tail).slice(1, -1));
    }
  });
});

describe("remote worker progress texts", () => {
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
