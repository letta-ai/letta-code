// A remote worker's progress reaches the parent's task logs: each tool call,
// text, and (from computers that keep them) full event, written once.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  accepted,
  FakeComputer,
  installRemoteLaunchTestHooks,
  launch,
  notified,
} from "./remote-external-coding-agent.test-helpers";
import { taskEventsFileFor } from "./task-transcript";

installRemoteLaunchTestHooks();

describe("remote worker progress in the task logs", () => {
  test("appends each remote tool call to the task output file once", async () => {
    const computer = new FakeComputer(() => accepted);
    const result = await launch([computer]);
    if (!result.success) throw new Error(result.error);
    const bash = {
      id: "toolu_1",
      name: "Bash",
      args: '{"command":"bun test"}',
    };
    const read = { id: "toolu_2", name: "Read", args: '{"file_path":"a.ts"}' };
    const edit = { id: "toolu_3", name: "Edit", args: '{"file_path":"a.ts"}' };
    computer.snapshot({ tool_calls: [bash] }, 1);
    await Bun.sleep(0);
    // Snapshots repeat the whole list; only new IDs are appended.
    computer.snapshot({ tool_calls: [bash, read] }, 2);
    await Bun.sleep(0);
    computer.snapshot({ tool_calls: [bash, read] }, 3);
    await Bun.sleep(0);
    // The terminal snapshot can carry a call no progress update showed.
    computer.snapshot(
      { status: "completed", result: "Done", tool_calls: [bash, read, edit] },
      4,
    );
    await notified();

    const output = readFileSync(result.output_file, "utf8");
    const progress = output
      .split("\n")
      .filter((line) => /^\[\d{4}-.+Z\] tool: /.test(line))
      .map((line) => line.replace(/^\[[^\]]+\] /, ""));
    expect(progress).toEqual([
      'tool: Bash {"command":"bun test"}',
      'tool: Read {"file_path":"a.ts"}',
      'tool: Edit {"file_path":"a.ts"}',
    ]);
    expect(output.indexOf("tool: Edit")).toBeLessThan(
      output.indexOf("subagent_status=success"),
    );
  });

  test("appends each remote progress text to the task output file once", async () => {
    const computer = new FakeComputer(() => accepted);
    const result = await launch([computer]);
    if (!result.success) throw new Error(result.error);
    const first = {
      id: "text-1",
      at: "2026-11-01T21:14:40.833Z",
      text: "Chat suite finished; cloud-api-integration is running.",
    };
    const second = {
      id: "text-2",
      at: "2026-11-01T21:47:03.554Z",
      text: "All suites passed.",
    };
    // An older listener sends no progress_texts at all.
    computer.snapshot({ status: "running" }, 1);
    await Bun.sleep(0);
    computer.snapshot({ progress_texts: [first] }, 2);
    await Bun.sleep(0);
    // Snapshots repeat the latest texts; only new IDs are appended.
    computer.snapshot({ progress_texts: [first] }, 3);
    await Bun.sleep(0);
    computer.snapshot(
      { status: "completed", result: "Done", progress_texts: [first, second] },
      4,
    );
    await notified();

    const output = readFileSync(result.output_file, "utf8");
    expect(
      output.split("\n").filter((line) => line.includes("] text: ")),
    ).toEqual([
      "[2026-11-01T21:14:40.833Z] text: Chat suite finished; cloud-api-integration is running.",
      "[2026-11-01T21:47:03.554Z] text: All suites passed.",
    ]);
    expect(output.indexOf("text: All suites passed.")).toBeLessThan(
      output.indexOf("subagent_status=success"),
    );
  });

  test("reads each remote event once, in full, when the worker announces event_seq", async () => {
    const computer = new FakeComputer(() => accepted);
    const result = await launch([computer]);
    if (!result.success) throw new Error(result.error);
    const output = `FAIL sum.test.ts\n${"x".repeat(10_000)}\nexpected 2, got 3`;
    const at = "2026-11-01T10:00:00.000Z";
    computer.events = [
      { seq: 1, at, type: "text", text: "Running the tests." },
      {
        seq: 2,
        at,
        type: "tool_call",
        id: "toolu_1",
        name: "Bash",
        input: { command: "bun test" },
      },
      {
        seq: 3,
        at,
        type: "tool_result",
        tool_call_id: "toolu_1",
        name: "Bash",
        is_error: true,
        output,
      },
    ];
    // The snapshot's short list repeats the call; it is not written twice.
    const bash = { id: "toolu_1", name: "Bash", args: '{"command":"bun…' };
    computer.snapshot({ event_seq: 3, tool_calls: [bash] }, 1);
    await Bun.sleep(5);
    computer.snapshot({ event_seq: 3, tool_calls: [bash] }, 2);
    await Bun.sleep(5);
    computer.events.push({
      seq: 4,
      at,
      type: "text",
      text: "sum.test.ts fails: expected 2, got 3.",
    });
    computer.snapshot(
      {
        status: "completed",
        result: "Done",
        event_seq: 4,
        tool_calls: [bash],
      },
      3,
    );
    await notified();

    // Pages of two, never re-reading what it has.
    expect(computer.eventReads.map((read) => read.after_seq)).toEqual([
      0, 2, 3,
    ]);
    const outputText = readFileSync(result.output_file, "utf8");
    expect(
      outputText
        .split("\n")
        .filter((line) => /^\[\d{4}-.+Z\] /.test(line))
        .map((line) => line.replace(/^\[[^\]]+\] /, "")),
    ).toEqual([
      "text: Running the tests.",
      'tool: Bash {"command":"bun test"}',
      "result: Bash error, 9.8 KB: FAIL sum.test.ts",
      "text: sum.test.ts fails: expected 2, got 3.",
    ]);
    const events = readFileSync(taskEventsFileFor(result.output_file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(events[2]?.output).toBe(output);
  });

  test("falls back to the snapshot's lists when event reads fail", async () => {
    const computer = new FakeComputer(() => accepted);
    computer.events = undefined;
    const result = await launch([computer]);
    if (!result.success) throw new Error(result.error);
    const bash = { id: "toolu_1", name: "Bash", args: '{"command":"ls"}' };
    computer.snapshot({ event_seq: 1, tool_calls: [bash] }, 1);
    await Bun.sleep(5);
    computer.snapshot(
      { status: "completed", result: "Done", event_seq: 2, tool_calls: [bash] },
      2,
    );
    await notified();
    const outputText = readFileSync(result.output_file, "utf8");
    expect(outputText.match(/tool: Bash \{"command":"ls"\}/g)).toHaveLength(1);
  });
});
