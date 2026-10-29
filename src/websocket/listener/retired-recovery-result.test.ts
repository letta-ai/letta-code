import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
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

test("retired exact recovery result reaches the next turn after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-retired-result-"));
  const store = createInterruptedTurnStore(directory);
  const exactResult = {
    type: "tool" as const,
    tool_call_id: "call-exact",
    tool_return: "completed exactly once",
    status: "success" as const,
  };
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  try {
    const predecessor = store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-predecessor",
      toolCallIds: [exactResult.tool_call_id],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/project",
      recoveryClaimCompletion: {
        lineageId: "lineage-exact",
        state: "running",
        effectToolCallIds: [exactResult.tool_call_id],
      },
    });
    const successor = store.write(
      {
        ...predecessor,
        runId: "run-successor",
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          ...predecessor.recoveryClaimCompletion,
          lineageId: "lineage-exact",
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectRunId: predecessor.runId,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
        },
      },
      predecessor.revision,
    );
    store.mergeSettledRecoveryResult({
      agentId: "agent-1",
      conversationId: "conv-1",
      lineageId: "lineage-exact",
      result: exactResult,
    });
    const pending = store.markRecoveryClaimCompletionPending({
      agentId: "agent-1",
      conversationId: "conv-1",
      lineageId: "lineage-exact",
      expectedRevision: store.readRecoverySnapshot(
        "agent-1",
        "conv-1",
        "lineage-exact",
      )?.revisionToken as string,
    });
    if (!pending?.revision) throw new Error("missing pending retirement");
    expect(
      store.retireRecoveryClaimCompletion({
        agentId: "agent-1",
        conversationId: "conv-1",
        lineageId: "lineage-exact",
        pendingRevision: pending.revision,
      }),
    ).toBe("preserved");

    const retired = store
      .listRecoverySidecars()
      .find((sidecar) => sidecar.lineageId === "lineage-exact");
    if (!retired) throw new Error("missing retired result sidecar");
    expect(store.compactRetiredRecoverySidecar(retired)).toBe(true);
    expect(
      store
        .listRecoverySidecars()
        .find((sidecar) => sidecar.lineageId === "lineage-exact"),
    ).toMatchObject({
      runId: null,
      toolCallIds: [exactResult.tool_call_id],
      results: [],
      exactResults: [exactResult],
      requestOtid: "",
      workingDirectory: "",
    });

    const restartedStore = createInterruptedTurnStore(directory);
    expect(restartedStore.list()[0]?.results).toContainEqual(exactResult);
    await recoverRecordedTurns(listener, {
      store: restartedStore,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          {
            toolCallId: exactResult.tool_call_id,
            toolName: "Bash",
            toolArgs: "{}",
          },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      setCwd: () => {},
      processTurn: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages?.[0]).toMatchObject({
      approvals: [exactResult],
    });
    const consumed = restartedStore.read("agent-1", "conv-1");
    if (!consumed?.revision) throw new Error("missing consumed recovery view");
    restartedStore.write(
      { ...consumed, runId: "run-after-consumption" },
      consumed.revision,
    );
    const consumedSidecar = restartedStore
      .listRecoverySidecars()
      .find((sidecar) => sidecar.lineageId === "lineage-exact");
    if (!consumedSidecar) throw new Error("missing consumed recovery sidecar");
    expect(restartedStore.compactRetiredRecoverySidecar(consumedSidecar)).toBe(
      true,
    );
    const compactedSidecar = restartedStore
      .listRecoverySidecars()
      .find((sidecar) => sidecar.lineageId === "lineage-exact");
    expect(compactedSidecar).toMatchObject({ toolCallIds: [] });
    expect(compactedSidecar?.exactResults).toBeUndefined();
    expect(successor.revision).toBeDefined();
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});
