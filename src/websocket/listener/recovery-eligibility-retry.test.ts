import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { setActiveRuntime } from "./runtime";
import type { handleIncomingMessage } from "./turn";
import { createTurnFinishedStore } from "./turn-finished-replay";

test("recovery eligibility conflict rearms and later owned work converges", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-conflict-owned-"));
  const store = createInterruptedTurnStore(join(directory, "interrupted"));
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  setActiveRuntime(listener);
  let eligibilityChecks = 0;
  let starts = 0;
  const complete = mock(async () => true);
  const deps = {
    store,
    terminalStore,
    backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
    resume: (async () => ({
      pendingApprovals: [
        { toolCallId: "call-1", toolName: "Bash", toolArgs: "{}" },
      ],
    })) as never,
    canRecover: async () => {
      eligibilityChecks += 1;
      return eligibilityChecks !== 2;
    },
    acquireClaim: async () => {
      let owned = true;
      return {
        get owned() {
          return owned;
        },
        complete: async () => {
          owned = false;
          return complete();
        },
        release: async () => {
          owned = false;
        },
        abandon: () => {
          owned = false;
        },
      } as never;
    },
    processTurn: async (...args: Parameters<typeof handleIncomingMessage>) => {
      starts += 1;
      const ownerRuntime = args[2];
      const turnLease = args[6];
      const lineageId = args[12];
      if (!lineageId) throw new Error("expected recovery lineage");
      const snapshot = store.readRecoverySnapshot(
        "agent-1",
        "conv-1",
        lineageId,
      );
      if (!snapshot) throw new Error("expected recovery snapshot");
      // A completed turn persists terminal evidence before releasing its lease.
      // Without it, recovery correctly starts the retained work again.
      terminalStore.put(
        "agent-1",
        "conv-1",
        { type: "turn_finished", turn_id: "turn-1", stop_reason: "end_turn" },
        {
          connectionId: "conn-replacement",
          canRotate: false,
          lineageId: "startup-1",
          interruptedRevision: snapshot.record.revision,
          interruptedAuthorityRevision: snapshot.revisionToken,
          recoveryLineageId: lineageId,
        },
      );
      if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
    },
    setCwd: () => {},
    retryDelayMs: 1,
  };
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, deps);
    expect(starts).toBe(0);
    expect(eligibilityChecks).toBe(2);
    const deadline = performance.now() + 2_000;
    while (store.read("agent-1", "conv-1") && performance.now() < deadline)
      await Bun.sleep(5);
    expect(store.read("agent-1", "conv-1")).toBeNull();
    expect(eligibilityChecks).toBeGreaterThanOrEqual(4);
    expect(starts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    await recoverRecordedTurns(listener, deps);
    expect(starts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    listener.intentionallyClosed = true;
    setActiveRuntime(null);
    rmSync(directory, { recursive: true, force: true });
  }
});
