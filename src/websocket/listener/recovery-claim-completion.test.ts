import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { markRecoveryClaimCompletionPending } from "./recovery-claim-completion";
import { setActiveRuntime } from "./runtime";
import { createTurnFinishedStore } from "./turn-finished-replay";

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1);
    }
  }
  throw lastError;
}

test("completion-pending transition rejects a newer same-lineage revision", () => {
  const directory = mkdtempSync(join(tmpdir(), "recovery-pending-cas-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const prepared = store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-prepared",
      toolCallIds: [],
      results: [],
      requestOtid: "request-prepared",
      workingDirectory: "/project",
      recoveryClaimCompletion: {
        lineageId: "lineage-running",
        state: "running",
      },
    });
    const successor = store.write(
      {
        ...prepared,
        runId: "run-successor",
        recoveryClaimCompletion: {
          lineageId: "lineage-running",
          state: "running",
          independentSuccessor: true,
        },
      },
      prepared.revision,
    );

    expect(markRecoveryClaimCompletionPending(store, prepared)).toBeNull();
    expect(store.read("agent-1", "conv-1")).toMatchObject({
      revision: successor.revision,
      runId: "run-successor",
      recoveryClaimCompletion: { state: "running" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "ACK",
    completeResult: true,
    loseClaim: false,
    throws: false,
    capacityFull: false,
  },
  {
    name: "negative ACK",
    completeResult: false,
    loseClaim: false,
    throws: false,
  },
  {
    name: "undefined ACK",
    completeResult: undefined,
    loseClaim: false,
    throws: false,
  },
  {
    name: "failed request",
    completeResult: false,
    loseClaim: false,
    throws: true,
  },
  { name: "claim loss", completeResult: false, loseClaim: true, throws: false },
  {
    name: "terminal capacity failure",
    completeResult: true,
    loseClaim: false,
    throws: false,
    capacityFull: true,
  },
])(
  "terminal running-marker recovery performs completion-only on $name",
  async ({ completeResult, loseClaim, throws, capacityFull }) => {
    const directory = mkdtempSync(join(tmpdir(), "recorded-running-marker-"));
    const store = createInterruptedTurnStore(join(directory, "interrupted"));
    const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
    const listener = createRuntime();
    listener.connectionId = "conn-replacement";
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({
        persistentPath: join(directory, "inputs.json"),
      });
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    listener.connections.set("conn-owner", {
      id: "conn-owner",
      initialized: true,
      subscriptions: new Set([runtime.key]),
      options: { connectionIdCanResume: false },
      startupOwner: { lineageId: "owner-lineage" },
    } as never);
    const identity = ordinaryInputIdentity("cm-terminal-running");
    if (!identity) throw new Error("expected identity");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: {
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [{ role: "user", content: "already executed" }],
        },
      }),
    ).toBe(true);
    const processTurn = mock(async () => {});
    const resume = mock(async () => ({ pendingApprovals: [] }));
    let completeCalls = 0;
    try {
      store.write({
        agentId: "agent-1",
        conversationId: "conv-1",
        runId: "run-terminal",
        toolCallIds: ["call-completed"],
        results: [
          {
            tool_call_id: "call-completed",
            status: "success",
            tool_return: "already-executed",
          },
        ],
        requestOtid: "request-completed",
        workingDirectory: "/project",
        durableInputIdentities: [identity],
        terminalConsumerIds: ["slack:agent-1"],
        recoveryClaimCompletion: {
          lineageId: "lineage-running",
          state: "running",
        },
      });
      if (capacityFull) {
        for (let index = 0; index < 64; index += 1) {
          terminalStore.put(
            "agent-1",
            "conv-1",
            {
              type: "turn_finished",
              turn_id: `existing-${index}`,
              stop_reason: "end_turn",
              terminal_consumer_ids: ["slack:agent-1"],
            },
            {
              connectionId: "conn-owner",
              canRotate: false,
              lineageId: "owner-lineage",
              terminalIdentity: `existing-terminal-${index}`,
            },
          );
        }
      }
      await recoverRecordedTurns(listener, {
        store,
        terminalStore,
        backend: {
          retrieveAgent: async () => ({ id: "agent-1" }),
          retrieveRun: async () => ({ status: "completed" }),
          streamConversationMessages: async () => ({
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              yield { run_id: "run-terminal" };
            },
          }),
        } as never,
        resume: resume as never,
        canRecover: async () => true,
        acquireClaim: (async () => {
          let owned = true;
          return {
            get owned() {
              return owned;
            },
            complete: async () => {
              completeCalls += 1;
              if (loseClaim) owned = false;
              if (throws) throw new Error("completion request failed");
              return completeResult;
            },
            release: async () => {
              owned = false;
            },
            abandon: () => {
              owned = false;
            },
          } as never;
        }) as never,
        processTurn: processTurn as never,
      });

      expect(completeCalls).toBe(capacityFull ? 0 : 1);
      expect(processTurn).toHaveBeenCalledTimes(0);
      expect(resume).toHaveBeenCalledTimes(1);
      if (!capacityFull) {
        expect(terminalStore.read("agent-1", "conv-1")?.terminals).toEqual([
          expect.objectContaining({
            message: expect.objectContaining({
              run_id: "run-terminal",
              terminal_consumer_ids: ["slack:agent-1"],
            }),
            owner: expect.objectContaining({
              interruptedRevision: expect.any(String),
            }),
          }),
        ]);
      }
      const retained = store.read("agent-1", "conv-1");
      if (completeResult && !capacityFull) {
        expect(retained).toBeNull();
      } else if (capacityFull) {
        expect(retained?.recoveryClaimCompletion).toMatchObject({
          lineageId: "lineage-running",
          state: "running",
        });
      } else {
        expect(retained).toMatchObject({
          runId: "run-terminal",
          results: [{ tool_return: "already-executed" }],
          recoveryClaimCompletion: {
            lineageId: "lineage-running",
            state: "pending",
          },
        });
      }
    } finally {
      listener.intentionallyClosed = true;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("pending completion ACK preserves and automatically revisits successor evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-pending-successor-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  setActiveRuntime(listener);
  let completeCalls = 0;
  const processTurn = mock(async () => {});
  const acquireClaim = (async () => {
    let owned = true;
    return {
      get owned() {
        return owned;
      },
      complete: async () => {
        completeCalls += 1;
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
  }) as never;
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      results: [
        {
          tool_call_id: "call-successor",
          status: "success",
          tool_return: "successor-result",
        },
      ],
      requestOtid: "request-successor",
      actingUserId: "actor-successor",
      workingDirectory: "/successor",
      durableInputIdentities: [{ domain: "input", id: "input-successor" }],
      recoveryClaimCompletion: {
        lineageId: "lineage-predecessor",
        state: "pending",
        effectRevision: "revision-predecessor",
        independentSuccessor: true,
      },
    });
    const deps = {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        retrieveRun: async () => ({ status: "completed" }),
        streamConversationMessages: async () => ({
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {
            yield { run_id: "run-successor" };
          },
        }),
      } as never,
      resume: (async () => ({ pendingApprovals: [] })) as never,
      canRecover: async () => true,
      acquireClaim,
      processTurn: processTurn as never,
      retryDelayMs: 0,
    };

    await recoverRecordedTurns(listener, deps);
    expect(completeCalls).toBe(1);
    expect(store.read("agent-1", "conv-1")).toMatchObject({
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      requestOtid: "request-successor",
      actingUserId: "actor-successor",
      results: [{ tool_return: "successor-result" }],
      durableInputIdentities: [{ domain: "input", id: "input-successor" }],
    });
    expect(
      store.read("agent-1", "conv-1")?.recoveryClaimCompletion,
    ).toBeUndefined();
    await eventually(() => expect(store.read("agent-1", "conv-1")).toBeNull());
    expect(completeCalls).toBe(1);
    expect(processTurn).toHaveBeenCalledTimes(0);
  } finally {
    listener.intentionallyClosed = true;
    setActiveRuntime(null);
    rmSync(directory, { recursive: true, force: true });
  }
});
