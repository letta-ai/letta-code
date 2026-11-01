import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeTaskProgressLog,
  openTaskProgressLog,
  recordTaskProgressText,
  recordTaskProgressToolCall,
  TASK_PROGRESS_MAX_LINES,
  TASK_PROGRESS_TEXT_CHARS,
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
