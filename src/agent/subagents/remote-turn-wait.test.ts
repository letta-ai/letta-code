import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Message,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  EnqueueReceipt,
  ExactSuperRun,
} from "@/backend/api/conversation-enqueue";
import {
  closeTaskProgressLog,
  openTaskProgressLog,
} from "@/tools/impl/task-transcript";
import { collectRemoteTurnResult } from "./remote-turn-wait";
import type { ExecutionState } from "./subagent-stream";

const SUBAGENT = "subagent-remote-1";
let dir: string | undefined;

afterEach(() => {
  closeTaskProgressLog(SUBAGENT);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-child",
  conversation_id: "conv-child",
  client_message_id: "cm-1",
  super_run_id: "sr-1",
  workflow_id: "wf-1",
};

function state(): ExecutionState {
  return {
    agentId: null,
    conversationId: null,
    finalResult: null,
    finalError: null,
    enqueueReceipt: null,
    resultStats: null,
    displayedToolCalls: new Set(),
    toolCallStatuses: new Map(),
  };
}

function superRun(runIds: string[], done = false): ExactSuperRun {
  return {
    id: "sr-1",
    status: done ? "COM" : "STR",
    completed_at: done ? "2026-11-01T10:00:09.000Z" : null,
    cancelled_at: null,
    errored_at: null,
    error: null,
    run_ids: runIds,
  };
}

let seq = 0;
function assistant(id: string, date: string, content: string): Message {
  return {
    id,
    date,
    message_type: "assistant_message",
    content,
    seq_id: ++seq,
  } as Message;
}

function toolReturn(id: string, date: string, output: string): Message {
  return {
    id: `${id}-return`,
    date,
    message_type: "tool_return_message",
    tool_call_id: `call-${id}`,
    status: "error",
    tool_return: output,
  } as Message;
}

function approval(id: string, date: string, command: string): Message {
  return {
    id,
    date,
    message_type: "approval_request_message",
    tool_call: {
      tool_call_id: `call-${id}`,
      name: "Bash",
      arguments: JSON.stringify({ command }),
    },
  } as Message;
}

test("streams a remote Letta subagent's progress into the output file while it runs", async () => {
  dir = mkdtempSync(join(tmpdir(), "remote-turn-progress-"));
  const outputFile = join(dir, "task.log");
  writeFileSync(outputFile, "[Task started: remote]\n\n");
  openTaskProgressLog(SUBAGENT, outputFile, { now: () => new Date(0) });

  // run-1 asks to run Bash; run-2 (after approval) says it is waiting, then
  // later finishes with the reply.
  const run1 = [
    assistant("m1", "2026-11-01T10:00:01.000Z", "Listing the checkout first."),
    approval("m1", "2026-11-01T10:00:01.000Z", "ls"),
  ];
  const run2Partial = [
    toolReturn(
      "m1",
      "2026-11-01T10:00:02.000Z",
      "error: build.ts:3 missing semicolon",
    ),
    {
      id: "n1",
      date: "2026-11-01T10:00:02.500Z",
      message_type: "user_message",
      content:
        "<task-notification>\n<task-id>bash_1</task-id>\n<summary>Command exited with code 1</summary>\n<result>FAIL test_sum: expected 2, got 3</result>\n</task-notification>",
    } as Message,
    // An ordinary user message is not progress.
    {
      id: "u1",
      date: "2026-11-01T10:00:02.600Z",
      message_type: "user_message",
      content: "keep going",
    } as Message,
    {
      id: "m2",
      date: "2026-11-01T10:00:03.000Z",
      message_type: "reasoning_message",
      reasoning: "Fix the semicolon, then rebuild.",
    } as Message,
    assistant("m2", "2026-11-01T10:00:03.000Z", "Build is running, waiting."),
  ];
  const run2Done = [
    ...run2Partial,
    assistant("m3", "2026-11-01T10:00:08.000Z", "Build passed."),
  ];
  const polls = [
    superRun([]),
    superRun(["run-1"]),
    superRun(["run-2", "run-1"]),
    superRun(["run-2", "run-1"]),
    superRun(["run-2", "run-1"], true),
  ];
  let poll = 0;
  let run2Reads = 0;
  const snapshots: string[] = [];
  const reads: string[] = [];

  const result = await collectRemoteTurnResult(
    receipt,
    state(),
    SUBAGENT,
    new AbortController().signal,
    {
      exact: async () => {
        snapshots.push(readFileSync(outputFile, "utf8"));
        return polls[Math.min(poll++, polls.length - 1)] as ExactSuperRun;
      },
      run: async (id) => ({ id, status: "completed" }) as Run,
      listMessages: async (runId) => {
        reads.push(runId);
        if (runId === "run-1") return run1;
        return ++run2Reads >= 3 ? run2Done : run2Partial;
      },
      pollMs: 0,
      progressMs: 0,
      sleep: async () => {},
    },
  );

  expect(result).toMatchObject({ success: true, report: "Build passed." });
  // Before the Super Run completed, the file already showed the first run's
  // text and tool call, and the second run's text.
  const midRun = snapshots[4] ?? "";
  expect(midRun).toBe(
    "[Task started: remote]\n\n" +
      "[1970-01-01T00:00:00.000Z] session: agent agent-child, conversation conv-child\n" +
      "[2026-11-01T10:00:01.000Z] text: Listing the checkout first.\n" +
      '[2026-11-01T10:00:01.000Z] tool: Bash {"command":"ls"}\n' +
      "[2026-11-01T10:00:02.000Z] result: Bash error, 35 B: error: build.ts:3 missing semicolon\n" +
      "[2026-11-01T10:00:02.500Z] notification: Command exited with code 1\n" +
      "[2026-11-01T10:00:03.000Z] text: Build is running, waiting.\n",
  );
  // The event log has the reasoning and the tool's full output.
  const events = readFileSync(join(dir, "task.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual([
    "session",
    "text",
    "tool_call",
    "tool_result",
    "notification",
    "reasoning",
    "text",
    "text",
  ]);
  expect(events[4]?.text).toContain("FAIL test_sum: expected 2, got 3");
  expect(events[3]).toMatchObject({
    tool_call_id: "call-m1",
    name: "Bash",
    is_error: true,
    output: "error: build.ts:3 missing semicolon",
  });
  // Each entry is written once, however many times its run is read.
  expect(readFileSync(outputFile, "utf8")).toBe(
    `${midRun}[2026-11-01T10:00:08.000Z] text: Build passed.\n`,
  );
  // A run with a newer sibling is finished and is not re-read.
  expect(reads.filter((id) => id === "run-1")).toHaveLength(2);
});

test("a failed progress read does not end the wait", async () => {
  dir = mkdtempSync(join(tmpdir(), "remote-turn-progress-"));
  const outputFile = join(dir, "task.log");
  openTaskProgressLog(SUBAGENT, outputFile, { now: () => new Date(0) });
  let poll = 0;
  let reads = 0;

  const result = await collectRemoteTurnResult(
    receipt,
    state(),
    SUBAGENT,
    new AbortController().signal,
    {
      exact: async () => superRun(["run-1"], poll++ > 0),
      run: async (id) => ({ id, status: "completed" }) as Run,
      listMessages: async () => {
        if (reads++ === 0) throw new Error("socket hang up");
        return [assistant("m1", "2026-11-01T10:00:01.000Z", "Done.")];
      },
      pollMs: 0,
      progressMs: 0,
      sleep: async () => {},
    },
  );

  expect(result).toMatchObject({ success: true, report: "Done." });
  expect(readFileSync(outputFile, "utf8")).toBe(
    "[1970-01-01T00:00:00.000Z] session: agent agent-child, conversation conv-child\n" +
      "[2026-11-01T10:00:01.000Z] text: Done.\n",
  );
});
