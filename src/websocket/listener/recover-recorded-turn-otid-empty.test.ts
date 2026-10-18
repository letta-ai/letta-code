import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";

test("an empty OTID lookup never proves an accepted request ended", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-otid-empty-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  let starts = 0;
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: null,
      toolCallIds: [],
      results: [],
      requestOtid: "accepted-request",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        streamConversationMessages: async () => ({
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {},
        }),
      } as never,
      resume: (async () => ({ pendingApprovals: [] })) as never,
      canRecover: async () => true,
      acquireClaim: (async () => ({
        owned: true,
        complete: async () => true,
        abandon: () => {},
      })) as never,
      processTurn: async () => {
        starts += 1;
      },
    });
    expect(starts).toBe(0);
    expect(store.read("agent-1", "conv-1")?.requestOtid).toBe(
      "accepted-request",
    );
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("empty OTID re-resolution never falls back to a retained old run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-old-run-empty-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  let retrieveRunCalls = 0;
  let streamCalls = 0;
  let claimCalls = 0;
  try {
    const written = store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-old",
      toolCallIds: ["call-old"],
      results: [
        {
          tool_call_id: "call-old",
          status: "success",
          tool_return: "done",
        },
      ],
      requestOtid: "",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        retrieveRun: async () => {
          retrieveRunCalls += 1;
          return { status: "completed" };
        },
        streamConversationMessages: async () => {
          streamCalls += 1;
          return {
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {},
          };
        },
      } as never,
      resume: (async () => ({ pendingApprovals: [] })) as never,
      canRecover: async () => true,
      acquireClaim: (async () => {
        claimCalls += 1;
        throw new Error("must not terminalize");
      }) as never,
    });
    expect(retrieveRunCalls).toBe(0);
    expect(streamCalls).toBe(0);
    expect(claimCalls).toBe(0);
    expect(store.read("agent-1", "conv-1")?.revision).toBe(written.revision);
    expect(store.read("agent-1", "conv-1")?.runId).toBe("run-old");
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});
