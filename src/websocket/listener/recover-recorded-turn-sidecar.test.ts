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

test("restart launches a predecessor from sidecar ownership snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-sidecar-owner-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  const workingDirectories: string[] = [];
  let claimCompletions = 0;
  const lineageId = "lineage-predecessor";
  try {
    const predecessor = store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [
        {
          type: "tool",
          tool_call_id: "call-predecessor",
          tool_return: "predecessor-result",
          status: "success",
        },
      ],
      requestOtid: "request-predecessor",
      actingUserId: "actor-predecessor",
      workingDirectory: "/predecessor",
      durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
      terminalConsumerIds: ["slack:predecessor"],
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        results: [],
        requestOtid: "request-successor",
        actingUserId: "actor-successor",
        workingDirectory: "/successor",
        durableInputIdentities: [{ domain: "input", id: "input-successor" }],
        terminalConsumerIds: ["slack:successor"],
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: predecessor.toolCallIds,
          effectRunId: predecessor.runId,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectActingUserId: predecessor.actingUserId,
          effectResults: predecessor.results,
          effectUnstartedToolCallIds: [],
          effectInputIdentities: predecessor.durableInputIdentities,
          effectTerminalConsumerIds: predecessor.terminalConsumerIds,
        },
      },
      predecessor.revision,
    );

    await recoverRecordedTurns(listener, {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          {
            toolCallId: "call-predecessor",
            toolName: "Bash",
            toolArgs: "{}",
          },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: async () => {
        let owned = true;
        return {
          get owned() {
            return owned;
          },
          complete: async () => {
            claimCompletions += 1;
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
      },
      setCwd: (_listener, _agentId, _conversationId, cwd) => {
        workingDirectories.push(cwd);
      },
      processTurn: async (message) => {
        sent.push(message);
      },
    });

    expect(workingDirectories).toEqual(["/predecessor"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      actingUserId: "actor-predecessor",
      durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
      terminalConsumerIds: ["slack:predecessor"],
      messages: [
        {
          type: "approval",
          otid: "request-predecessor",
          approvals: [{ tool_call_id: "call-predecessor" }],
        },
      ],
    });
    await Promise.resolve();
    expect(claimCompletions).toBe(0);
    expect(
      store.readRecoveryView("agent-1", "conv-1", lineageId),
    ).not.toBeNull();
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart defers when the recovery sidecar changes across a backend await", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-sidecar-fence-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const lineageId = "lineage-fence";
  let starts = 0;
  try {
    const predecessor = store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [
        {
          type: "approval",
          tool_call_id: "call-predecessor",
          approve: false,
          reason: "unknown",
        },
      ],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        results: [],
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: predecessor.toolCallIds,
          effectRunId: predecessor.runId,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
        },
      },
      predecessor.revision,
    );

    await recoverRecordedTurns(listener, {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => {
        store.writeRecoveryLineageSnapshot({
          agentId: "agent-1",
          conversationId: "conv-1",
          lineageId,
          update: {
            results: [],
            unstartedToolCallIds: ["call-predecessor"],
          },
        });
        return {
          pendingApprovals: [
            {
              toolCallId: "call-predecessor",
              toolName: "Bash",
              toolArgs: "{}",
            },
          ],
        };
      }) as never,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      processTurn: async () => {
        starts += 1;
      },
    });

    expect(starts).toBe(0);
    expect(
      store.readRecoveryView("agent-1", "conv-1", lineageId),
    ).toMatchObject({
      results: [],
      unstartedToolCallIds: ["call-predecessor"],
    });
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});
