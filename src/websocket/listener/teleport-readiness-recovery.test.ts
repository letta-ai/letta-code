import { expect, test } from "bun:test";
import WebSocket from "ws";
import { TestDirectory } from "@/test-utils/test-fs";
import type {
  TeleportContinuation,
  TeleportRequestCommand,
} from "@/types/protocol_v2";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import {
  claimPendingTeleportAtBoundary,
  finishTeleport,
  handleTeleportRequest,
  setTeleportInterruptedTurnStoreForTests,
} from "./teleport";
import {
  createTeleportRecoveryStore,
  type TeleportRecoveryStore,
} from "./teleport-recovery-store";
import type { ListenerRuntime, StartListenerOptions } from "./types";

class MockSocket {
  readonly bufferedAmount = 0;
  readonly readyState = WebSocket.OPEN;
  readonly sent: unknown[] = [];
  isOpen() {
    return true;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
}

const interruptedStores = new WeakMap<
  ListenerRuntime,
  ReturnType<typeof createInterruptedTurnStore>
>();

function options(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://app-server.test",
    deviceId: "source-device",
    connectionName: "Source",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function openSource(
  listener: ListenerRuntime,
  socket: MockSocket,
  directory: TestDirectory,
  connectionId = "source",
): void {
  if (!interruptedStores.has(listener)) {
    const store = createInterruptedTurnStore(
      `${directory.path}/interrupted-turns`,
    );
    interruptedStores.set(listener, store);
    setTeleportInterruptedTurnStoreForTests(listener, store);
  }
  openListenerConnection({
    runtime: listener,
    connectionId,
    writer: socket as never,
    options: options(connectionId),
  });
  subscribeListenerConnection(listener, connectionId, {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  markListenerConnectionInitialized(listener, connectionId);
}

function command(
  teleportId: string,
  requestId = teleportId,
): TeleportRequestCommand {
  return {
    type: "teleport_request",
    request_id: requestId,
    teleport_id: teleportId,
    runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
    target: {
      connection_id: "target",
      device_id: "target-device",
      connection_name: "Target",
    },
  };
}

function seedInterrupted(listener: ListenerRuntime): void {
  interruptedStores.get(listener)?.write({
    agentId: "agent-1",
    conversationId: "conversation-1",
    runId: "run-source",
    toolCallIds: [],
    results: [],
    requestOtid: "source-request",
    workingDirectory: process.cwd(),
  });
}

test("proof-write failure cannot expose replayable readiness", () => {
  const directory = new TestDirectory();
  try {
    const durable = createTeleportRecoveryStore(`${directory.path}/ledger`);
    const crashingStore: TeleportRecoveryStore = {
      read: (teleportId) => durable.read(teleportId),
      write: () => {
        throw new Error("simulated preparing write failure");
      },
      remove: (teleportId) => durable.remove(teleportId),
    };
    const listener = createRuntime();
    listener.teleportRecoveryStore = crashingStore;
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conversation-1",
    );
    const socket = new MockSocket();
    openSource(listener, socket, directory);
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command("teleport-proof-failure"),
    });
    const pending = claimPendingTeleportAtBoundary({
      listener,
      agentId: "agent-1",
      conversationId: "conversation-1",
      activeTurn: true,
    });
    if (!pending) throw new Error("Teleport did not reach the source boundary");
    seedInterrupted(listener);

    expect(() => finishTeleport(runtime, lease, pending)).toThrow(
      "simulated preparing write failure",
    );
    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command(
        "teleport-proof-failure",
        "teleport-proof-failure-retry",
      ),
    });
    expect(durable.read("teleport-proof-failure")).toBeNull();
    expect(
      socket.sent.filter(
        (message) => (message as { type?: string }).type === "teleport_ready",
      ),
    ).toHaveLength(0);
  } finally {
    directory.cleanup();
  }
});

test("ambiguous suspension write cannot replay while the source lease is active", () => {
  const directory = new TestDirectory();
  try {
    const durable = createTeleportRecoveryStore(`${directory.path}/ledger`);
    const interrupted = createInterruptedTurnStore(
      `${directory.path}/interrupted`,
    );
    const listener = createRuntime();
    listener.teleportRecoveryStore = durable;
    const faultingInterruptedStore = {
      ...interrupted,
      writeDurable: (
        record: Parameters<typeof interrupted.writeDurable>[0],
      ) => {
        interrupted.writeDurable(record);
        throw new Error("simulated suspension directory fsync fault");
      },
    };
    interruptedStores.set(listener, faultingInterruptedStore);
    setTeleportInterruptedTurnStoreForTests(listener, faultingInterruptedStore);
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conversation-1",
    );
    const socket = new MockSocket();
    openSource(listener, socket, directory);
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command("teleport-suspension-fault"),
    });
    const pending = claimPendingTeleportAtBoundary({
      listener,
      agentId: "agent-1",
      conversationId: "conversation-1",
      activeTurn: true,
    });
    if (!pending) throw new Error("Teleport did not reach the source boundary");
    seedInterrupted(listener);
    expect(() => finishTeleport(runtime, lease, pending)).toThrow(
      "simulated suspension directory fsync fault",
    );
    expect(runtime.turnLifecycle.kind).toBe("active");

    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command("teleport-suspension-fault", "suspension-fault-retry"),
    });
    expect(socket.sent).toHaveLength(0);
    expect(durable.read("teleport-suspension-fault")).toMatchObject({
      phase: "preparing",
    });
  } finally {
    directory.cleanup();
  }
});

test("restart promotes suspended preparing proof across app-server ordinals", () => {
  const directory = new TestDirectory();
  try {
    const durable = createTeleportRecoveryStore(`${directory.path}/ledger`);
    let failStoppedCommit = true;
    const crashingStore: TeleportRecoveryStore = {
      read: (teleportId) => durable.read(teleportId),
      write: (record) => {
        if (record.phase === "source_stopped" && failStoppedCommit) {
          failStoppedCommit = false;
          throw new Error("simulated process loss before stopped commit");
        }
        durable.write(record);
      },
      remove: (teleportId) => durable.remove(teleportId),
    };
    const interrupted = createInterruptedTurnStore(
      `${directory.path}/interrupted`,
    );
    const listener = createRuntime();
    listener.teleportRecoveryStore = crashingStore;
    interruptedStores.set(listener, interrupted);
    setTeleportInterruptedTurnStoreForTests(listener, interrupted);
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conversation-1",
    );
    const socket = new MockSocket();
    openSource(listener, socket, directory, "app-server-5");
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    handleTeleportRequest({
      listener,
      connectionId: "app-server-5",
      command: command("teleport-restart"),
    });
    const continuation: TeleportContinuation = {
      approvals: [
        {
          type: "approval",
          tool_call_id: "call-restart",
          approve: true,
        },
      ],
    };
    const pending = claimPendingTeleportAtBoundary({
      listener,
      agentId: "agent-1",
      conversationId: "conversation-1",
      activeTurn: true,
      continuation,
    });
    if (!pending) throw new Error("Teleport did not reach the source boundary");
    seedInterrupted(listener);
    expect(() => finishTeleport(runtime, lease, pending)).toThrow(
      "simulated process loss before stopped commit",
    );
    expect(durable.read("teleport-restart")).toMatchObject({
      phase: "preparing",
    });

    const restarted = createRuntime();
    restarted.teleportRecoveryStore = durable;
    interruptedStores.set(restarted, interrupted);
    setTeleportInterruptedTurnStoreForTests(restarted, interrupted);
    const restartedSocket = new MockSocket();
    openSource(restarted, restartedSocket, directory, "app-server-0");
    handleTeleportRequest({
      listener: restarted,
      connectionId: "app-server-0",
      command: command("teleport-restart", "restart-request"),
    });

    expect(durable.read("teleport-restart")).toMatchObject({ phase: "ready" });
    expect(restartedSocket.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        success: true,
        active_turn: true,
        continuation,
      }),
    );
  } finally {
    directory.cleanup();
  }
});

test("restart replays an immutable source rejection instead of re-deciding", () => {
  const directory = new TestDirectory();
  try {
    const durable = createTeleportRecoveryStore(`${directory.path}/ledger`);
    durable.write({
      teleportId: "teleport-rejected-replay",
      agentId: "agent-1",
      conversationId: "conversation-1",
      sourceDeviceId: "source-device",
      sourceSessionId: "listen-original",
      disposition: "rejected",
      phase: "ready",
      readiness: {
        client_preferences: {},
        success: false,
        active_turn: false,
        mode: "strict",
        error: "Original source rejection",
      },
      recordedAt: Date.now(),
    });
    const listener = createRuntime();
    listener.teleportRecoveryStore = durable;
    const socket = new MockSocket();
    openSource(listener, socket, directory, "app-server-3");
    handleTeleportRequest({
      listener,
      connectionId: "app-server-3",
      command: command("teleport-rejected-replay", "rejected-retry"),
    });
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        success: false,
        active_turn: false,
        mode: "strict",
        error: "Original source rejection",
      }),
    );
  } finally {
    directory.cleanup();
  }
});

test("restart keeps unsuspended preparing proof non-authoritative for source recovery", () => {
  const directory = new TestDirectory();
  try {
    const durable = createTeleportRecoveryStore(`${directory.path}/ledger`);
    durable.write({
      teleportId: "teleport-unsuspended",
      agentId: "agent-1",
      conversationId: "conversation-1",
      sourceDeviceId: "source-device",
      sourceSessionId: "listen-original",
      disposition: "yielded",
      phase: "preparing",
      readiness: {
        client_preferences: {},
        success: true,
        active_turn: true,
        mode: "standard",
        continuation: {
          approvals: [
            {
              type: "approval",
              tool_call_id: "must-not-replay",
              approve: true,
            },
          ],
        },
      },
      recordedAt: Date.now(),
    });
    const listener = createRuntime();
    listener.teleportRecoveryStore = durable;
    const socket = new MockSocket();
    openSource(listener, socket, directory, "app-server-0");
    seedInterrupted(listener);
    handleTeleportRequest({
      listener,
      connectionId: "app-server-0",
      command: command("teleport-unsuspended", "unsuspended-retry"),
    });
    expect(socket.sent).toHaveLength(0);
    expect(durable.read("teleport-unsuspended")).toMatchObject({
      phase: "preparing",
    });
    expect(listener.pendingTeleports?.has("teleport-unsuspended")).toBe(true);
  } finally {
    directory.cleanup();
  }
});
