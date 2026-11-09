import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { loadPreparedInputTerminals } from "./input-terminal-journal";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import type { handleIncomingMessage } from "./turn";
import { createTurnFinishedStore } from "./turn-finished-replay";
import type { IncomingMessage } from "./types";

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

/**
 * A run that stops for a client-side tool finishes server-side as
 * `completed` with `requires_approval`, even while its listener is down.
 * Its pending approval is the rest of the turn, not a stale leftover.
 */
test.each([
  ["completed", "requires_approval", 1],
  ["completed", "end_turn", 0],
  ["failed", "error", 0],
] as const)(
  "a %s/%s recorded run continues its pending approval %d time(s)",
  async (status, stopReason, continuations) => {
    const directory = mkdtempSync(join(tmpdir(), "recorded-run-approval-"));
    const store = createInterruptedTurnStore(join(directory, "interrupted"));
    const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
    const listener = createRuntime();
    listener.connectionId = "conn-replacement";
    const sent: IncomingMessage[] = [];
    try {
      store.write({
        agentId: "agent-1",
        conversationId: "conv-1",
        runId: "run-model",
        toolCallIds: [],
        results: [],
        requestOtid: "previous-request",
        workingDirectory: "/project",
      });
      await recoverRecordedTurns(listener, {
        store,
        terminalStore,
        backend: {
          retrieveAgent: async () => ({ id: "agent-1" }),
          retrieveRun: async () => ({ status, stop_reason: stopReason }),
          retrieveMessage: async () => [{ run_id: "run-model" }],
        } as never,
        resume: (async () => ({
          pendingApprovals: [
            {
              toolCallId: "call-step-2",
              toolName: "Bash",
              toolArgs: "{}",
              messageId: "message-step-2",
            },
          ],
        })) as never,
        canRecover: async () => true,
        acquireClaim: acquireTestClaim,
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

      expect(sent).toHaveLength(continuations);
      if (continuations) {
        expect(sent[0]?.messages?.[0]).toMatchObject({
          type: "approval",
          approvals: [{ tool_call_id: "call-step-2" }],
        });
        expect(loadPreparedInputTerminals(listener)).toHaveLength(0);
      } else {
        expect(store.read("agent-1", "conv-1")).toBeNull();
      }
    } finally {
      listener.intentionallyClosed = true;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
