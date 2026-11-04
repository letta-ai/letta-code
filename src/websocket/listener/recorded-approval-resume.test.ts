import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import {
  recordedRunAwaitsApproval,
  resumeRecordedUnstartedApprovals,
} from "./recorded-approval-resume";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import type { handleIncomingMessage } from "./turn";
import type { IncomingMessage } from "./types";

const claim = async () => {
  let owned = true;
  return {
    get owned() {
      return owned;
    },
    complete: async () => {
      owned = false;
      return true;
    },
    release: async () => {
      owned = false;
    },
    abandon: () => {
      owned = false;
    },
  } as never;
};

/**
 * Production sequence: the machine stops while the listener runs a tool. The
 * server finishes that run with `requires_approval` for the next call, which
 * no listener is connected to receive. The replacement listener starts with
 * the old record and must answer that approval, not drop it as finished.
 */
test("a run that stopped at requires_approval keeps its pending approval after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-requires-approval-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-step-2"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        retrieveRun: async () => ({
          id: "run-1",
          status: "completed",
          stop_reason: "requires_approval",
        }),
        retrieveMessage: async () => [{ run_id: "run-1" }],
      } as never,
      resume: (async () => ({
        pendingApprovals: [
          {
            toolCallId: "call-step-3",
            toolName: "Bash",
            toolArgs: "{}",
            messageId: "message-step-3",
          },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: claim,
      processTurn: async (
        ...args: Parameters<typeof handleIncomingMessage>
      ) => {
        sent.push(args[0]);
        const lease = args[6];
        if (lease) {
          getOrCreateScopedRuntime(
            listener,
            "agent-1",
            "conv-1",
          ).turnLifecycle.finish(lease, "end_turn");
        }
      },
      setCwd: () => {},
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages?.[0]).toMatchObject({
      type: "approval",
      approvals: [{ tool_call_id: "call-step-3", approve: false }],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only runs still waiting on the server keep pending approvals", () => {
  expect(recordedRunAwaitsApproval({ status: "running" })).toBe(true);
  expect(
    recordedRunAwaitsApproval({
      status: "completed",
      stop_reason: "requires_approval",
    }),
  ).toBe(true);
  expect(
    recordedRunAwaitsApproval({ status: "completed", stop_reason: "end_turn" }),
  ).toBe(false);
  expect(
    recordedRunAwaitsApproval({ status: "failed", stop_reason: "error" }),
  ).toBe(false);
});

/**
 * A record whose pending call never crossed its execution boundary used to be
 * deferred until an owner sent `sync { resume_interrupted_turn: true }`. A
 * restarted hosted listener has no such sender, so it resumes by itself.
 */
test("recorded unstarted approvals resume through owner sync recovery", async () => {
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const calls: string[] = [];
  let retried = 0;
  await new Promise<void>((resolve) => {
    resumeRecordedUnstartedApprovals(
      listener,
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-1" },
      () => {
        retried += 1;
      },
      {
        recover: async (_runtime, scope, _deps, opts) => {
          calls.push(
            `recover:${scope.conversation_id}:${opts?.resumeInterruptedTurn}`,
          );
          return undefined;
        },
        startContinuation: async () => {
          calls.push("continue");
          resolve();
          return true;
        },
      },
    );
  });
  expect(calls).toEqual(["recover:conv-1:true", "continue"]);
  expect(retried).toBe(0);
});

test("unstarted approval resume retries while ownership is unresolved", async () => {
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  let started = false;
  await new Promise<void>((resolve) => {
    resumeRecordedUnstartedApprovals(
      listener,
      runtime,
      { agent_id: "agent-1", conversation_id: "conv-1" },
      resolve,
      {
        recover: async () => "deferred",
        startContinuation: async () => {
          started = true;
          return true;
        },
        retryDelayMs: 1,
      },
    );
  });
  expect(started).toBe(false);
});
