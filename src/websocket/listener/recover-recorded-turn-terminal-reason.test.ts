import { expect, test } from "bun:test";
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
import { loadPreparedInputTerminals } from "./input-terminal-journal";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { createTurnFinishedStore } from "./turn-finished-replay";

const acquireTestClaim = async () => {
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

test.each([
  ["failed", "error"],
  ["cancelled", "cancelled"],
] as const)(
  "a %s backend run preserves its terminal stop reason",
  async (runStatus, expectedStopReason) => {
    const directory = mkdtempSync(join(tmpdir(), "recorded-run-terminal-"));
    const store = createInterruptedTurnStore(join(directory, "interrupted"));
    const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
    const listener = createRuntime();
    listener.connectionId = "conn-replacement";
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({
        persistentPath: join(directory, "inputs.json"),
      });
    try {
      let processTurns = 0;
      const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
      const identity = ordinaryInputIdentity(`cm-${runStatus}`);
      if (!identity) throw new Error("expected identity");
      const admission = reserveInputDisposition(runtime, identity);
      if (admission.kind !== "reserved")
        throw new Error("expected reservation");
      expect(
        commitInputDisposition(runtime, admission.reservation, "started", {
          incoming: {
            type: "message",
            agentId: "agent-1",
            conversationId: "conv-1",
            durableInputIdentities: [identity],
            messages: [{ role: "user", content: "recover terminal" }],
          },
        }),
      ).toBe(true);
      store.write({
        agentId: "agent-1",
        conversationId: "conv-1",
        runId: `run-${runStatus}`,
        toolCallIds: [],
        results: [],
        requestOtid: `request-${runStatus}`,
        workingDirectory: "/project",
        durableInputIdentities: [identity],
        terminalConsumerIds: ["slack:agent-1"],
      });

      await recoverRecordedTurns(listener, {
        store,
        terminalStore,
        backend: {
          retrieveAgent: async () => ({ id: "agent-1" }),
          retrieveRun: async () => ({ status: runStatus }),
        } as never,
        resume: (async () => ({
          pendingApprovals: [
            {
              toolCallId: "stale-approval",
              toolName: "stale_tool",
              toolArgs: {},
            },
          ],
        })) as never,
        canRecover: async () => true,
        acquireClaim: acquireTestClaim,
        processTurn: async () => {
          processTurns += 1;
        },
      });

      expect(loadPreparedInputTerminals(listener)[0]?.message.stop_reason).toBe(
        expectedStopReason,
      );
      expect(processTurns).toBe(0);
    } finally {
      listener.intentionallyClosed = true;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
