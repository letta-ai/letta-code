import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import type { ListenerTransport } from "./transport";
import {
  createTurnFinishedStore,
  replayPendingTurnFinishedToConnection,
} from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "listener-durability-"));
  directories.push(directory);
  return directory;
}

function recordedWork() {
  return {
    agentId: "agent-1",
    conversationId: "conversation-1",
    runId: "run-1",
    toolCallIds: ["tool-1"],
    results: [
      {
        type: "tool" as const,
        tool_call_id: "tool-1",
        tool_return: "exact-result",
        status: "success" as const,
      },
    ],
    requestOtid: "otid-1",
    workingDirectory: process.cwd(),
  };
}

test("transport interruption retains executed work while explicit abort removes it", () => {
  const store = createInterruptedTurnStore(temporaryDirectory());
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );

  store.write(recordedWork());
  const transportLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  runtime.turnLifecycle.markTransportInterruption(transportLease);
  finishListenerTurn(runtime, transportLease, {
    stopReason: "cancelled",
    conversationId: "conversation-1",
    forgetWork: () => store.remove("agent-1", "conversation-1"),
  });
  expect(store.read("agent-1", "conversation-1")?.results).toEqual(
    recordedWork().results,
  );

  const abortLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  runtime.turnLifecycle.requestCancellation({ cause: "explicit_user" });
  finishListenerTurn(runtime, abortLease, {
    stopReason: "cancelled",
    conversationId: "conversation-1",
    forgetWork: () => store.remove("agent-1", "conversation-1"),
  });
  expect(store.read("agent-1", "conversation-1")).toBeNull();
});

test("a backpressure drop replays turn_finished once to its replacement", async () => {
  const store = createTurnFinishedStore(temporaryDirectory());
  const predecessor = createRuntime();
  predecessor.connectionId = "conn-predecessor";
  const predecessorRuntime = getOrCreateScopedRuntime(
    predecessor,
    "agent-1",
    "conversation-1",
  );
  const blockedTransport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 17 * 1024 * 1024,
    isOpen: () => true,
    send: () => {
      throw new Error("backpressured terminal must not be sent");
    },
  };
  const blockedConnection = openListenerConnection({
    runtime: predecessor,
    connectionId: "conn-predecessor",
    writer: blockedTransport,
    options: {
      connectionId: "conn-predecessor",
      wsUrl: "local://test",
      deviceId: "device",
      connectionName: "test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  subscribeListenerConnection(predecessor, blockedConnection.id, {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  markListenerConnectionInitialized(
    predecessor,
    blockedConnection.id,
    blockedConnection,
  );
  const lease = predecessorRuntime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  predecessorRuntime.turnLifecycle.markTransportInterruption(lease);
  finishListenerTurn(predecessorRuntime, lease, {
    socket: blockedTransport,
    turnId: "turn-1",
    runId: "run-1",
    stopReason: "cancelled",
    agentId: "agent-1",
    conversationId: "conversation-1",
    turnFinishedStore: store,
    forgetWork: () => {},
  });
  await Bun.sleep(0);
  expect(
    store
      .read("agent-1", "conversation-1")
      ?.terminals.map((terminal) => terminal.message.turn_id),
  ).toEqual(["turn-1"]);

  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const sent: string[] = [];
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => sent.push(payload),
  };
  const connection = openListenerConnection({
    runtime: listener,
    connectionId: "conn-replacement",
    writer: transport,
    options: {
      connectionId: "conn-replacement",
      wsUrl: "local://test",
      deviceId: "device",
      connectionName: "test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  subscribeListenerConnection(listener, connection.id, {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  markListenerConnectionInitialized(listener, connection.id, connection);

  replayPendingTurnFinishedToConnection(
    transport,
    runtime,
    connection.id,
    store,
  );
  await Bun.sleep(0);
  replayPendingTurnFinishedToConnection(
    transport,
    runtime,
    connection.id,
    store,
  );
  await Bun.sleep(0);

  const terminals = sent
    .map((payload) => JSON.parse(payload) as { type: string; turn_id?: string })
    .filter((message) => message.type === "turn_finished");
  expect(terminals).toHaveLength(1);
  expect(terminals[0]?.turn_id).toBe("turn-1");
  expect(store.read("agent-1", "conversation-1")).toBeNull();
});

test("process-style terminal recovery retains a terminal with no owner", async () => {
  const directory = temporaryDirectory();
  createTurnFinishedStore(directory).put("agent-1", "conversation-1", {
    type: "turn_finished",
    turn_id: "turn-process",
    stop_reason: "end_turn",
  });

  const restartedStore = createTurnFinishedStore(directory);
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {
      throw new Error("no target should be selected");
    },
  };
  replayPendingTurnFinishedToConnection(
    transport,
    runtime,
    "missing-owner",
    restartedStore,
  );
  await Bun.sleep(0);

  expect(
    restartedStore
      .read("agent-1", "conversation-1")
      ?.terminals.map((terminal) => terminal.message.turn_id),
  ).toEqual(["turn-process"]);
});

test("an observer receipt cannot retire the authoritative owner's terminal", async () => {
  const store = createTurnFinishedStore(temporaryDirectory());
  const listener = createRuntime();
  listener.connectionId = "conn-owner";
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const ownerTransport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 17 * 1024 * 1024,
    isOpen: () => true,
    send: () => {
      throw new Error("backpressured owner must not send");
    },
  };
  const observerPayloads: string[] = [];
  const observerTransport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => observerPayloads.push(payload),
  };
  for (const [connectionId, writer] of [
    ["conn-owner", ownerTransport],
    ["conn-observer", observerTransport],
  ] as const) {
    const connection = openListenerConnection({
      runtime: listener,
      connectionId,
      writer,
      options: {
        connectionId,
        wsUrl: "local://test",
        deviceId: "device",
        connectionName: connectionId,
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    });
    subscribeListenerConnection(listener, connectionId, {
      agent_id: "agent-1",
      conversation_id: "conversation-1",
    });
    markListenerConnectionInitialized(listener, connectionId, connection);
  }
  runtime.activeConnectionId = "conn-owner";
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  finishListenerTurn(runtime, lease, {
    socket: ownerTransport,
    turnId: "turn-owner",
    stopReason: "end_turn",
    agentId: "agent-1",
    conversationId: "conversation-1",
    turnFinishedStore: store,
    forgetWork: () => {},
  });
  await Bun.sleep(0);
  expect(
    observerPayloads.some((payload) => payload.includes("turn_finished")),
  ).toBe(true);
  expect(store.read("agent-1", "conversation-1")?.terminals).toHaveLength(1);

  suspendListenerConnection(listener, "conn-owner");
  await Bun.sleep(0);
  expect(store.read("agent-1", "conversation-1")?.terminals).toHaveLength(1);
});

test("terminal persistence failure leaves the turn lease active", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const failingStore = {
    read: () => null,
    put: () => {
      throw new Error("durable terminal unavailable");
    },
    remove: () => {},
  } as unknown as ReturnType<typeof createTurnFinishedStore>;

  expect(() =>
    finishListenerTurn(runtime, lease, {
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      turnId: "turn-not-finalized",
      stopReason: "end_turn",
      agentId: "agent-1",
      conversationId: "conversation-1",
      turnFinishedStore: failingStore,
    }),
  ).toThrow("durable terminal unavailable");
  expect(runtime.turnLifecycle.kind).toBe("active");
  expect(runtime.turnLifecycle.isCurrent(lease)).toBe(true);
});
