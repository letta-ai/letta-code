import { expect, test } from "bun:test";
import WebSocket from "ws";
import { createBuffers } from "@/cli/helpers/accumulator";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createInterruptedTurnStore,
  recordListenerWork,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { createRecoveredTurnFinalizer } from "./recovered-turn-finalizer";
import { handleTeleportFailure, handleTeleportRequest } from "./teleport";
import { createTurnCorrelation } from "./turn-correlation";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createTurnFinalizer } from "./turn-finalizer";
import { finishListenerTurn } from "./turn-terminal";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
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

function makeOptions(): StartListenerOptions {
  return {
    connectionId: "source",
    wsUrl: "ws://app-server.test",
    deviceId: "source-device",
    connectionName: "Source",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

test("recovered finalization fences against the latest evidence revision", () => {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  try {
    const listener = createRuntime();
    listener.connectionId = "conn-recovered-finalizer";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conversation-1",
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    const initialRevision = recordListenerWork(
      runtime,
      { runId: "run-recovered" },
      "run_observed",
    );
    const latestRevision = recordListenerWork(
      runtime,
      { results: [] },
      "after_tool_execution",
      initialRevision,
    );
    expect(initialRevision).toBeString();
    expect(latestRevision).toBeString();
    expect(latestRevision).not.toBe(initialRevision);
    const finalizer = createRecoveredTurnFinalizer({
      runtime,
      recoveryLease: lease,
      recovered: {
        agentId: "agent-1",
        conversationId: "conversation-1",
        interruptedRevision: initialRevision,
      },
      getInterruptedRevision: () => latestRevision,
      canCommit: () => true,
    });

    const transition = finalizer({
      stopReason: "end_turn",
      socket: new MockSocket() as never,
      agentId: "agent-1",
      conversationId: "conversation-1",
      turnId: "recovered-finalizer",
    });

    expect(transition.finished).toBe(true);
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(
      createInterruptedTurnStore().read("agent-1", "conversation-1"),
    ).toBeNull();
  } finally {
    process.env.HOME = oldHome;
    directory.cleanup();
  }
});

test.each(["end_turn", "max_steps", "cancelled", "error"] as const)(
  "production finalizer commits %s against its journaled teleport revision",
  (stopReason) => {
    const oldHome = process.env.HOME;
    const directory = new TestDirectory();
    process.env.HOME = directory.path;
    try {
      const listener = createRuntime();
      listener.connectionId = "conn-drained-finalizer";
      const runtime = getOrCreateScopedRuntime(
        listener,
        "agent-1",
        "conversation-1",
      );
      const socket = new MockSocket();
      openListenerConnection({
        runtime: listener,
        connectionId: "source",
        writer: socket as never,
        options: makeOptions(),
      });
      subscribeListenerConnection(listener, "source", {
        agent_id: "agent-1",
        conversation_id: "conversation-1",
      });
      markListenerConnectionInitialized(listener, "source");
      const lease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      const predecessorRevision = recordListenerWork(
        runtime,
        { runId: "run-predecessor" },
        "run_observed",
      );
      expect(predecessorRevision).toBeString();
      runtime.pendingTurns = 1;
      handleTeleportRequest({
        listener,
        connectionId: "source",
        command: {
          type: "teleport_request",
          request_id: "teleport-drained-request",
          teleport_id: "teleport-drained",
          runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
          target: {
            connection_id: "target",
            device_id: "target-device",
            connection_name: "Target",
          },
        },
      });
      runtime.pendingTurns = 0;
      const incoming: IncomingMessage = {
        type: "message",
        agentId: "agent-1",
        conversationId: "conversation-1",
        messages: [{ role: "user", content: "finish predecessor" }],
      };
      const ownership = createTurnDurabilityOwnership();
      ownership.recordInput(incoming);
      const finalizer = createTurnFinalizer({
        runtime,
        turnLease: lease,
        socket: socket as never,
        ownership,
        turnCorrelation: createTurnCorrelation(
          runtime,
          incoming,
          "batch-drained",
        ),
        buffers: createBuffers("agent-1"),
        agentId: "agent-1",
        conversationId: "conversation-1",
        interruptedRevisionRef: { current: predecessorRevision },
      });

      const transition = finalizer.finishTurn({
        stopReason,
        conversationId: "conversation-1",
      });
      expect(transition.finished).toBe(true);
      expect(runtime.turnLifecycle.kind).toBe("idle");
      const ready = createInterruptedTurnStore().read(
        "agent-1",
        "conversation-1",
      );
      expect(ready?.teleport).toMatchObject({
        teleportId: "teleport-drained",
        ready: true,
      });
      expect(ready?.teleport?.committedRevision).toBeString();
      expect(ready?.teleport?.committedRevision).not.toBe(predecessorRevision);

      const staleLease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      expect(
        finishListenerTurn(runtime, staleLease, {
          stopReason: "end_turn",
          conversationId: "conversation-1",
          expectedInterruptedRevision: predecessorRevision,
        }).finished,
      ).toBe(false);
      expect(runtime.turnLifecycle.kind).toBe("active");
      runtime.turnLifecycle.finish(staleLease, "cancelled");
      expect(
        createInterruptedTurnStore().read("agent-1", "conversation-1")
          ?.teleport,
      ).toMatchObject({ teleportId: "teleport-drained", ready: true });
    } finally {
      createInterruptedTurnStore().remove("agent-1", "conversation-1");
      directory.cleanup();
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  },
);

test("failure admission cleanup never retargets an inherited successor revision", async () => {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  const listener = createRuntime();
  listener.connectionId = "conn-cleanup-race";
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-cleanup",
    "conversation-cleanup",
  );
  const socket = new MockSocket();
  try {
    const predecessorRevision = recordListenerWork(
      runtime,
      {
        runId: "run-predecessor",
        teleport: {
          teleportId: "teleport-cleanup-race",
          connectionId: "source",
          activeTurn: false,
          ready: true,
        },
      },
      "run_observed",
    );
    if (!predecessorRevision) throw new Error("expected predecessor revision");
    const realStore = createInterruptedTurnStore();
    const attemptedRevisions: Array<string | null> = [];
    let firstAttempt = true;
    const cleanupStore = {
      ...realStore,
      remove: (
        agentId: string,
        conversationId: string,
        revision?: string | null,
      ) => {
        attemptedRevisions.push(revision ?? null);
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("lock temporarily unavailable");
        }
        return realStore.remove(agentId, conversationId, revision);
      },
    };
    let continuation: Promise<void> | undefined;
    handleTeleportFailure({
      listener,
      command: {
        type: "teleport_failed",
        teleport_id: "teleport-cleanup-race",
        runtime: {
          agent_id: "agent-cleanup",
          conversation_id: "conversation-cleanup",
        },
        error: "destination failed",
      },
      socket: socket as never,
      connectionId: "source",
      getOrCreateScopedRuntime: () => runtime,
      runDetachedListenerTask: (_name, task) => {
        continuation = task();
      },
      processIncomingMessage: async () => {},
      failedTeleportCleanup: {
        store: cleanupStore,
        retryDelayMs: 10,
        maxAttempts: 4,
      },
    });
    expect(attemptedRevisions).toEqual([predecessorRevision]);

    const successorRevision = recordListenerWork(
      runtime,
      { runId: "run-successor" },
      "run_observed",
      predecessorRevision,
    );
    expect(successorRevision).toBeString();
    expect(successorRevision).not.toBe(predecessorRevision);
    expect(
      realStore.read("agent-cleanup", "conversation-cleanup")?.teleport,
    ).toMatchObject({ teleportId: "teleport-cleanup-race" });

    const deadline = performance.now() + 2_000;
    while (attemptedRevisions.length < 2 && performance.now() < deadline) {
      await Bun.sleep(5);
    }
    await continuation;
    expect(attemptedRevisions).toEqual([
      predecessorRevision,
      predecessorRevision,
    ]);
    expect(
      realStore.read("agent-cleanup", "conversation-cleanup"),
    ).toMatchObject({
      revision: successorRevision,
      runId: "run-successor",
      teleport: { teleportId: "teleport-cleanup-race" },
    });
  } finally {
    listener.intentionallyClosed = true;
    createInterruptedTurnStore().remove(
      "agent-cleanup",
      "conversation-cleanup",
    );
    directory.cleanup();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
