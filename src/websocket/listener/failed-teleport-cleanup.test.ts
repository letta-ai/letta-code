import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  cancelFailedTeleportCleanup,
  getFailedTeleportCleanupPendingCount,
} from "./failed-teleport-cleanup";
import { createAcceptedInputDispositionLedger } from "./input-disposition";
import {
  createInterruptedTurnStore,
  recordListenerWork,
} from "./interrupted-turn-record";
import { createRuntime, stopRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { clearAcceptedFailedTeleport, handleTeleportFailure } from "./teleport";

function pendingTeleport(
  teleportId: string,
  conversationId: string,
  interruptedRevision = `revision-${conversationId}`,
) {
  return {
    teleportId,
    connectionId: "source",
    agentId: "agent-cleanup",
    conversationId,
    requestedAt: Date.now(),
    drainAcceptedInputs: false,
    activeTurn: false,
    interruptedRevision,
  };
}

test("permanent failed teleport cleanup exhausts exactly and releases all retry state", async () => {
  const listener = createRuntime();
  const pending = pendingTeleport(
    "teleport-permanent",
    "conversation-cleanup",
    "revision-permanent",
  );
  const record = {
    revision: "revision-permanent",
    agentId: pending.agentId,
    conversationId: pending.conversationId,
    runId: null,
    toolCallIds: [],
    results: [],
    requestOtid: "request-permanent",
    workingDirectory: "/project",
    teleport: {
      teleportId: pending.teleportId,
      connectionId: pending.connectionId,
      activeTurn: false,
      ready: true,
    },
  };
  let removals = 0;
  const store = {
    read: () => record,
    remove: () => {
      removals += 1;
      throw new Error("lock unavailable");
    },
  } as never;

  clearAcceptedFailedTeleport(listener, pending, {
    store,
    retryDelayMs: 1,
    maxAttempts: 4,
  });
  const deadline = performance.now() + 2_000;
  while (removals < 4 && performance.now() < deadline) await Bun.sleep(5);
  expect(removals).toBe(4);
  await Bun.sleep(50);
  expect(removals).toBe(4);
  expect(getFailedTeleportCleanupPendingCount(listener)).toBe(0);
  expect(record.teleport.teleportId).toBe(pending.teleportId);
});

test("failed teleport cleanup caps unique pending keys and close cancels its worker", async () => {
  const listener = createRuntime();
  let removals = 0;
  const store = {
    read: (agentId: string, conversationId: string) => ({
      revision: `revision-${conversationId}`,
      agentId,
      conversationId,
      runId: null,
      toolCallIds: [],
      results: [],
      requestOtid: `request-${conversationId}`,
      workingDirectory: "/project",
      teleport: {
        teleportId: `teleport-${conversationId}`,
        connectionId: "source",
        activeTurn: false,
        ready: true,
      },
    }),
    remove: () => {
      removals += 1;
      throw new Error("lock unavailable");
    },
  } as never;
  for (let index = 0; index < 20; index += 1) {
    const conversationId = `conversation-${index}`;
    clearAcceptedFailedTeleport(
      listener,
      pendingTeleport(`teleport-${conversationId}`, conversationId),
      { store, retryDelayMs: 10, maxAttempts: 8, pendingLimit: 3 },
    );
  }
  expect(getFailedTeleportCleanupPendingCount(listener)).toBe(3);
  expect(removals).toBe(3);

  stopRuntime(listener, true);
  expect(getFailedTeleportCleanupPendingCount(listener)).toBe(0);
  await Bun.sleep(30);
  expect(removals).toBe(3);
  clearAcceptedFailedTeleport(
    listener,
    pendingTeleport("teleport-after-close", "after-close"),
    { store, retryDelayMs: 1 },
  );
  expect(removals).toBe(3);
  cancelFailedTeleportCleanup(listener);
});

test.each(["throw", "pending-cap"] as const)(
  "%s cleanup cannot leave a continuation successor stale across restart",
  async (failureMode) => {
    const directory = mkdtempSync(join(tmpdir(), "failed-teleport-restart-"));
    const store = createInterruptedTurnStore(join(directory, "interrupted"));
    const dispositionPath = join(directory, "dispositions.json");
    const listener = createRuntime();
    listener.connectionId = "conn-original";
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: dispositionPath });
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-cleanup",
      "conversation-restart",
    );
    const pending = pendingTeleport("teleport-restart", "conversation-restart");
    let detachedTask: Promise<void> | undefined;
    try {
      const predecessor = store.write({
        agentId: pending.agentId,
        conversationId: pending.conversationId,
        runId: "run-predecessor",
        toolCallIds: ["call-predecessor"],
        results: [],
        requestOtid: "request-predecessor",
        workingDirectory: "/predecessor",
        teleport: {
          teleportId: pending.teleportId,
          connectionId: pending.connectionId,
          activeTurn: false,
          ready: true,
        },
      });
      if (!predecessor.revision)
        throw new Error("expected predecessor revision");
      pending.interruptedRevision = predecessor.revision;
      listener.pendingTeleports = new Map([
        [
          JSON.stringify([
            pending.agentId,
            pending.conversationId,
            pending.teleportId,
          ]),
          pending,
        ],
      ]);

      const throwingStore = {
        ...store,
        remove: () => {
          throw new Error("cleanup unavailable");
        },
      } as never;
      if (failureMode === "pending-cap") {
        clearAcceptedFailedTeleport(
          listener,
          pendingTeleport("teleport-blocker", "conversation-blocker"),
          {
            store: throwingStore,
            retryDelayMs: 60_000,
            pendingLimit: 1,
          },
        );
        expect(getFailedTeleportCleanupPendingCount(listener)).toBe(1);
      }

      handleTeleportFailure({
        listener,
        command: {
          type: "teleport_failed",
          teleport_id: pending.teleportId,
          runtime: {
            agent_id: pending.agentId,
            conversation_id: pending.conversationId,
          },
          error: "destination unavailable",
        },
        socket: { isOpen: () => true, send: () => {} } as never,
        connectionId: "conn-original",
        getOrCreateScopedRuntime: () => runtime,
        runDetachedListenerTask: (_name, task) => {
          detachedTask = task();
        },
        processIncomingMessage: async (incoming) => {
          recordListenerWork(
            runtime,
            {
              runId: "run-successor",
              toolCallIds: ["call-successor"],
              results: [
                {
                  tool_call_id: "call-successor",
                  status: "success",
                  tool_return: "successor-effect",
                },
              ],
              requestOtid: "request-successor",
              durableInputIdentities: incoming.durableInputIdentities
                ? [...incoming.durableInputIdentities]
                : undefined,
            },
            "after_tool_execution",
            undefined,
            undefined,
            store,
          );
        },
        failedTeleportCleanup:
          failureMode === "throw"
            ? {
                store: throwingStore,
                retryDelayMs: 1,
                maxAttempts: 1,
              }
            : {
                store,
                pendingLimit: 1,
              },
      });
      await detachedTask;

      const successor = store.read(pending.agentId, pending.conversationId);
      expect(successor).toMatchObject({
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        results: [
          {
            tool_call_id: "call-successor",
            tool_return: "successor-effect",
          },
        ],
        requestOtid: "request-successor",
        durableInputIdentities: [
          { domain: "teleport", id: pending.teleportId },
        ],
      });
      expect(successor?.teleport).toBeUndefined();
      if (!successor) throw new Error("expected successor record");
      expect(
        store.remove(
          pending.agentId,
          pending.conversationId,
          predecessor.revision,
        ),
      ).toBe(false);

      const restarted = createRuntime();
      restarted.connectionId = "conn-restarted";
      restarted.acceptedInputDispositionLedger =
        createAcceptedInputDispositionLedger({
          persistentPath: dispositionPath,
        });
      const teleportStatus = mock(async () => ({ status: "failed" as const }));
      await recoverRecordedTurns(restarted, {
        store,
        canRecover: async () => false,
        teleportStatus: teleportStatus as never,
        retryDelayMs: 60_000,
      });
      expect(teleportStatus).not.toHaveBeenCalled();
      expect(store.read(pending.agentId, pending.conversationId)).toEqual(
        successor,
      );
      expect(
        restoreDurableQueuedInputs(restarted, undefined, [successor]),
      ).toBe(0);
      expect(
        restoreDurableQueuedInputs(restarted, undefined, [successor]),
      ).toBe(0);
      expect(
        getOrCreateScopedRuntime(
          restarted,
          pending.agentId,
          pending.conversationId,
        ).queueRuntime.length,
      ).toBe(0);
      restarted.intentionallyClosed = true;
    } finally {
      cancelFailedTeleportCleanup(listener);
      listener.intentionallyClosed = true;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("failed teleport cleanup CAS loss never deletes an immediate successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "failed-teleport-successor-"));
  const realStore = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  const pending = pendingTeleport("teleport-race", "conversation-race");
  try {
    const predecessor = realStore.write({
      agentId: pending.agentId,
      conversationId: pending.conversationId,
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      teleport: {
        teleportId: pending.teleportId,
        connectionId: pending.connectionId,
        activeTurn: false,
        ready: true,
      },
    });
    if (!predecessor.revision) throw new Error("expected predecessor revision");
    pending.interruptedRevision = predecessor.revision;
    let raced = false;
    const store = {
      ...realStore,
      remove: (...args: Parameters<typeof realStore.remove>) => {
        if (!raced) {
          raced = true;
          const current = realStore.read(
            pending.agentId,
            pending.conversationId,
          );
          if (!current?.revision) throw new Error("expected predecessor");
          realStore.write(
            {
              agentId: pending.agentId,
              conversationId: pending.conversationId,
              runId: "run-successor",
              toolCallIds: ["call-successor"],
              results: [],
              requestOtid: "request-successor",
              workingDirectory: "/successor",
            },
            current.revision,
          );
        }
        return realStore.remove(...args);
      },
    };

    clearAcceptedFailedTeleport(listener, pending, {
      store,
      retryDelayMs: 1,
      maxAttempts: 4,
    });
    expect(
      realStore.read(pending.agentId, pending.conversationId),
    ).toMatchObject({
      runId: "run-successor",
      requestOtid: "request-successor",
    });
    const deadline = performance.now() + 2_000;
    while (
      getFailedTeleportCleanupPendingCount(listener) > 0 &&
      performance.now() < deadline
    ) {
      await Bun.sleep(5);
    }
    expect(getFailedTeleportCleanupPendingCount(listener)).toBe(0);
    expect(
      realStore.read(pending.agentId, pending.conversationId),
    ).toMatchObject({
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      requestOtid: "request-successor",
    });
  } finally {
    cancelFailedTeleportCleanup(listener);
    rmSync(directory, { recursive: true, force: true });
  }
});
