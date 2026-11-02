import { expect, test } from "bun:test";
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

const say = (id: string, second: number, content: string) =>
  ({
    id,
    date: `2026-11-01T10:00:0${second}.000Z`,
    message_type: "assistant_message",
    content,
    seq_id: second,
  }) as Message;

test("streams a remote Letta subagent's progress into the output file while it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-turn-progress-"));
  const outputFile = join(dir, "task.log");
  writeFileSync(outputFile, "");
  openTaskProgressLog(SUBAGENT, outputFile);
  // run-1 asks to run Bash (client-side tools arrive as approval requests);
  // run-2 says it is waiting, then finishes with the reply.
  const run1 = [
    say("m1", 1, "Listing the checkout first."),
    {
      id: "m1",
      date: "2026-11-01T10:00:01.000Z",
      message_type: "approval_request_message",
      tool_call: { tool_call_id: "c1", name: "Bash", arguments: '{"cmd":1}' },
    } as Message,
  ];
  const run2 = [
    {
      id: "m1r",
      date: "2026-11-01T10:00:02.000Z",
      message_type: "tool_return_message",
      tool_call_id: "c1",
      status: "success",
      tool_return: "a.txt",
    } as Message,
    say("m2", 3, "Build is running."),
    // A background command's output arrives only as a notification turn.
    {
      id: "m2n",
      date: "2026-11-01T10:00:04.000Z",
      message_type: "user_message",
      content:
        "<task-notification><summary>Build failed</summary>error: x</task-notification>",
    } as Message,
  ];
  const polls = [
    superRun(["run-1"]),
    superRun(["run-2", "run-1"]),
    superRun(["run-2", "run-1"]),
    superRun(["run-2", "run-1"], true),
  ];
  let poll = 0;
  let reads = 0;
  let run2Reads = 0;
  const midRun: string[] = [];
  try {
    const result = await collectRemoteTurnResult(
      {
        status: "queued",
        agent_id: "agent-1",
        conversation_id: "conv-1",
        super_run_id: "sr-1",
      } as EnqueueReceipt,
      { displayedToolCalls: new Set() } as ExecutionState,
      SUBAGENT,
      new AbortController().signal,
      {
        exact: async () => {
          midRun.push(readFileSync(outputFile, "utf8"));
          return polls[Math.min(poll++, polls.length - 1)] as ExactSuperRun;
        },
        run: async (id) => ({ id, status: "completed" }) as Run,
        listMessages: async (runId) => {
          // A failed progress read is skipped, not fatal.
          if (reads++ === 0) throw new Error("socket hang up");
          if (runId === "run-1") return run1;
          if (++run2Reads < 3) return run2;
          return [...run2, say("m3", 8, "Build passed.")];
        },
        pollMs: 0,
        progressMs: 0,
        sleep: async () => {},
      },
    );

    expect(result).toMatchObject({ success: true, report: "Build passed." });
    // Before the Super Run completed, both runs' progress was in the file.
    expect(midRun[3]).toBe(
      "[2026-11-01T10:00:01.000Z] text: Listing the checkout first.\n" +
        '[2026-11-01T10:00:01.000Z] tool: Bash {"cmd":1}\n' +
        "[2026-11-01T10:00:02.000Z] result: Bash ok, 5 B\n" +
        "[2026-11-01T10:00:03.000Z] text: Build is running.\n" +
        "[2026-11-01T10:00:04.000Z] notification: Build failed\n",
    );
    // Each entry is written once, however often its run is re-read.
    expect(readFileSync(outputFile, "utf8")).toBe(
      `${midRun[3]}[2026-11-01T10:00:08.000Z] text: Build passed.\n`,
    );
  } finally {
    closeTaskProgressLog(SUBAGENT);
    rmSync(dir, { recursive: true, force: true });
  }
});
