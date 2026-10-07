import { expect, mock, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  commitInputDisposition,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { setActiveRuntime } from "./runtime";
import { createTurnFinishedStore } from "./turn-finished-replay";
import type { StartListenerOptions } from "./types";
import { __listenerWarmupTestUtils } from "./warmup";

class OpenSocket {
  readonly bufferedAmount = 0;
  readonly readyState = WebSocket.OPEN;
  readonly sent: unknown[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function connectionOptions(): StartListenerOptions {
  return {
    connectionId: "conn-owner",
    wsUrl: "ws://listener.test",
    deviceId: "device-owner",
    connectionName: "Owner",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(2);
    }
  }
  throw lastError;
}

test("real recovered turns retire an ACKed predecessor before processing its independent successor", async () => {
  const directory = new TestDirectory();
  const originalHome = process.env.HOME;
  const agentId = "agent-production-recovery";
  const conversationId = "default";
  process.env.HOME = directory.path;
  await settingsManager.reset();

  const backend = new FakeHeadlessBackend(agentId, undefined, {
    storageDir: directory.createDir("backend"),
  });
  const streamSpy = spyOn(backend, "createConversationMessageStream");
  const retrieveAgentSpy = spyOn(backend, "retrieveAgent");
  const recoveryBackend = {
    retrieveAgent: backend.retrieveAgent.bind(backend),
    retrieveRun: async (runId: string) => ({ id: runId, status: "running" }),
  } as never;
  __testSetBackend(backend);
  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => false,
    ensureSecretsHydratedForAgent: async () => {},
  });

  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  listener.connectionGeneration = "generation-replacement";
  const socket = new OpenSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "conn-owner",
    writer: socket as never,
    options: connectionOptions(),
  });
  subscribeListenerConnection(listener, "conn-owner", {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  markListenerConnectionInitialized(listener, "conn-owner");
  setActiveRuntime(listener);

  try {
    await settingsManager.initialize();
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);
    runtime.skillSources = [];
    const predecessorIdentity = ordinaryInputIdentity("input-predecessor");
    const successorIdentity = ordinaryInputIdentity("input-successor");
    if (!predecessorIdentity || !successorIdentity)
      throw new Error("missing deterministic input identities");
    for (const identity of [predecessorIdentity, successorIdentity]) {
      const admission = reserveInputDisposition(runtime, identity);
      if (admission.kind !== "reserved")
        throw new Error(`failed to reserve ${identity.id}`);
      expect(
        commitInputDisposition(runtime, admission.reservation, "started"),
      ).toBe(true);
    }

    const store = createInterruptedTurnStore();
    const terminalStore = createTurnFinishedStore();
    const lineageId = "lineage-predecessor";
    const predecessor = store.write({
      agentId,
      conversationId,
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [
        {
          tool_call_id: "call-predecessor",
          status: "success",
          tool_return: "predecessor-result",
        },
      ],
      requestOtid: "request-predecessor",
      workingDirectory: directory.path,
      durableInputIdentities: [predecessorIdentity],
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    const successor = store.write(
      {
        ...predecessor,
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
        durableInputIdentities: [successorIdentity],
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectRunId: predecessor.runId,
          effectToolCallIds: predecessor.toolCallIds,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
          effectInputIdentities: predecessor.durableInputIdentities,
        },
      },
      predecessor.revision,
    );
    const predecessorSnapshot = store.readRecoverySnapshot(
      agentId,
      conversationId,
      lineageId,
    );
    if (!predecessorSnapshot)
      throw new Error("missing predecessor recovery authority");

    const order: string[] = [];
    const terminalOwners: unknown[] = [];
    const authorityTokens: string[] = [];
    let claimNumber = 0;
    const acquireClaim = mock(async () => {
      const number = ++claimNumber;
      let owned = true;
      return {
        get owned() {
          return owned;
        },
        complete: async () => {
          order.push(`claim-${number}-complete`);
          const completionSnapshot = store.readRecoverySnapshot(
            agentId,
            conversationId,
            number === 1
              ? lineageId
              : (store.read(agentId, conversationId)?.recoveryClaimCompletion
                  ?.lineageId ?? "missing-successor-lineage"),
          );
          if (completionSnapshot)
            authorityTokens.push(completionSnapshot.revisionToken);
          terminalOwners.push(
            terminalStore.read(agentId, conversationId)?.terminals.at(-1)
              ?.owner,
          );
          if (number === 1) {
            expect(store.read(agentId, conversationId)).toMatchObject({
              revision: successor.revision,
              runId: "run-successor",
              toolCallIds: ["call-successor"],
            });
          }
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
    });
    const resume = mock(async () => {
      const current = store.read(agentId, conversationId);
      const recoveringPredecessor =
        current?.recoveryClaimCompletion?.independentSuccessor === true;
      return {
        pendingApprovals: [
          {
            toolCallId: recoveringPredecessor
              ? "call-predecessor"
              : "call-successor",
            toolName: "Bash",
            toolArgs: "{}",
          },
        ],
      };
    });

    await recoverRecordedTurns(listener, {
      store,
      terminalStore,
      backend: recoveryBackend,
      resume: resume as never,
      canRecover: async () => true,
      acquireClaim: acquireClaim as never,
      setCwd: () => {},
      retryDelayMs: 1,
    });

    await eventually(() => {
      expect(streamSpy).toHaveBeenCalledTimes(2);
      expect(acquireClaim).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["claim-1-complete", "claim-2-complete"]);
      expect(store.read(agentId, conversationId)).toBeNull();
    });
    expect(terminalOwners[0]).toMatchObject({
      interruptedRevision: predecessor.revision,
      recoveryLineageId: lineageId,
    });
    const predecessorTerminalAuthority = (
      terminalOwners[0] as { interruptedAuthorityRevision?: string }
    ).interruptedAuthorityRevision;
    expect(predecessorTerminalAuthority).toBeDefined();
    expect(predecessorTerminalAuthority).not.toBe(
      predecessorSnapshot.revisionToken,
    );
    expect(predecessorTerminalAuthority).not.toBe(authorityTokens[0]);
    const successorOwner = terminalOwners[1] as {
      interruptedRevision?: string;
      interruptedAuthorityRevision?: string;
      recoveryLineageId?: string;
    };
    expect(successorOwner.interruptedRevision).toBeDefined();
    expect(successorOwner.interruptedRevision).toBe(
      successorOwner.interruptedAuthorityRevision,
    );
    expect(successorOwner.interruptedRevision).not.toBe(successor.revision);
    expect(successorOwner.recoveryLineageId).toBeDefined();
    expect(
      streamSpy.mock.calls.map((call) =>
        JSON.stringify(call[1]).includes("call-predecessor")
          ? "predecessor"
          : "successor",
      ),
    ).toEqual(["predecessor", "successor"]);

    await recoverRecordedTurns(listener, {
      store,
      terminalStore,
      backend: recoveryBackend,
      resume: resume as never,
      canRecover: async () => true,
      acquireClaim: acquireClaim as never,
      retryDelayMs: 1,
    });
    expect(streamSpy).toHaveBeenCalledTimes(2);
    expect(acquireClaim).toHaveBeenCalledTimes(2);
    expect(retrieveAgentSpy).toHaveBeenCalled();
  } finally {
    listener.intentionallyClosed = true;
    setActiveRuntime(null);
    __listenerWarmupTestUtils.resetWarmupDepsForTests();
    __testSetBackend(null);
    await settingsManager.reset();
    process.env.HOME = originalHome;
    directory.cleanup();
  }
}, 15_000);
