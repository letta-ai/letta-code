import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { parseServerMessage } from "./protocol-inbound";
import type { ListenerTransport } from "./transport";
import {
  acknowledgeTurnFinished,
  createTurnFinishedStore,
  encodeTurnFinishedScope,
  prepareTurnFinished,
  replayPendingTurnFinishedToConnection,
  TURN_FINISHED_REPLAY_TTL_MS,
} from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";

const directories: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "listener-durability-"));
  directories.push(directory);
  return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for durability state");
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
      connectionIdCanResume: false,
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
  predecessorRuntime.activeConnectionId = blockedConnection.id;
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
  await waitFor(
    () =>
      store.read("agent-1", "conversation-1")?.terminals[0]?.claim ===
      undefined,
  );
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
    .map(
      (payload) =>
        JSON.parse(payload) as {
          type: string;
          turn_id?: string;
          idempotency_key?: string;
        },
    )
    .filter((message) => message.type === "turn_finished");
  expect(terminals).toHaveLength(1);
  expect(terminals[0]?.turn_id).toBe("turn-1");
  expect(terminals[0]?.idempotency_key).toBe(
    store.read("agent-1", "conversation-1")?.terminals[0]?.id,
  );
  // Local send settlement is not an application receipt.
  expect(store.read("agent-1", "conversation-1")?.terminals).toHaveLength(1);
  expect(
    acknowledgeTurnFinished({
      agentId: "agent-1",
      conversationId: "conversation-1",
      connectionId: connection.id,
      idempotencyKey: terminals[0]?.idempotency_key ?? "",
      store,
    }),
  ).toBe(true);
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

test("an observer never receives or retires the authoritative owner's terminal", async () => {
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
  ).toBe(false);
  expect(store.read("agent-1", "conversation-1")?.terminals).toHaveLength(1);

  suspendListenerConnection(listener, "conn-owner");
  await Bun.sleep(0);
  expect(store.read("agent-1", "conversation-1")?.terminals).toHaveLength(1);
});

test("terminal persistence failure is visible without wedging the turn lease", () => {
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
  expect(runtime.turnLifecycle.kind).toBe("idle");
  expect(runtime.turnLifecycle.isCurrent(lease)).toBe(false);
});

test("arbitrary stable connection ids receive durable terminals", async () => {
  const store = createTurnFinishedStore(temporaryDirectory());
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, null, "app-conversation");
  const sent: string[] = [];
  const connectionId = "app-server-generation-17";
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => sent.push(payload),
  };
  const connection = openListenerConnection({
    runtime: listener,
    connectionId,
    writer: transport,
    options: {
      connectionId,
      wsUrl: "local://app-server",
      deviceId: "device",
      connectionName: "app-server",
      connectionIdCanResume: true,
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  subscribeListenerConnection(listener, connectionId, {
    agent_id: null,
    conversation_id: "app-conversation",
  });
  markListenerConnectionInitialized(listener, connectionId, connection);
  runtime.activeConnectionId = connectionId;
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });

  finishListenerTurn(runtime, lease, {
    socket: transport,
    turnId: "app-turn",
    stopReason: "end_turn",
    agentId: null,
    conversationId: "app-conversation",
    turnFinishedStore: store,
    forgetWork: () => {},
  });
  await Bun.sleep(0);

  const terminal = sent
    .map(
      (payload) =>
        JSON.parse(payload) as { type?: string; idempotency_key?: string },
    )
    .find((frame) => frame.type === "turn_finished");
  expect(terminal?.idempotency_key).toBe(
    store.read(null, "app-conversation")?.terminals[0]?.id,
  );
  expect(store.read(null, "app-conversation")?.terminals).toHaveLength(1);
});

test("rotating App Server and process-owned terminals remain explicit best effort", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, null, "app-conversation");
  const connectionId = "app-server-generation-17";
  const connection = openListenerConnection({
    runtime: listener,
    connectionId,
    writer: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options: {
      connectionId,
      wsUrl: "local://app-server",
      deviceId: "device",
      connectionName: "app-server",
      connectionIdCanResume: false,
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  subscribeListenerConnection(listener, connectionId, {
    agent_id: null,
    conversation_id: "app-conversation",
  });
  markListenerConnectionInitialized(listener, connectionId, connection);
  runtime.activeConnectionId = connectionId;

  expect(
    prepareTurnFinished(runtime, {
      type: "turn_finished",
      turn_id: "app-turn",
      stop_reason: "end_turn",
    }),
  ).toEqual({ kind: "ephemeral" });

  runtime.activeConnectionId = null;
  expect(
    prepareTurnFinished(runtime, {
      type: "turn_finished",
      turn_id: "process-turn",
      stop_reason: "end_turn",
    }),
  ).toEqual({ kind: "ephemeral" });
});

test("the 65th process terminal is bounded and client capacity failure cleans its lease", () => {
  const store = createTurnFinishedStore(temporaryDirectory());
  for (let index = 0; index < 65; index += 1) {
    store.put(null, "process", {
      type: "turn_finished",
      turn_id: `process-${index}`,
      stop_reason: "end_turn",
    });
  }
  expect(store.read(null, "process")?.terminals).toHaveLength(64);
  expect(store.read(null, "process")?.terminals.at(-1)?.message.turn_id).toBe(
    "process-64",
  );

  for (let index = 0; index < 64; index += 1) {
    store.put(
      "agent-capacity",
      "client",
      {
        type: "turn_finished",
        turn_id: `client-${index}`,
        stop_reason: "end_turn",
      },
      { connectionId: "owner", canRotate: false, lineageId: null },
    );
  }
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-capacity",
    "client",
  );
  runtime.activeConnectionId = "owner";
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  expect(() =>
    finishListenerTurn(runtime, lease, {
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      turnId: "client-65",
      stopReason: "end_turn",
      conversationId: "client",
      turnFinishedStore: store,
    }),
  ).toThrow("capacity exceeded");
  expect(runtime.turnLifecycle.kind).toBe("idle");
});

test("terminal replay identity survives an offline restart before 24 hours", () => {
  const directory = temporaryDirectory();
  const startedAt = Date.UTC(2026, 0, 1);
  setSystemTime(new Date(startedAt));
  const terminal = createTurnFinishedStore(directory).put(
    "agent",
    "conversation",
    { type: "turn_finished", turn_id: "stable", stop_reason: "end_turn" },
    { connectionId: "owner", canRotate: false, lineageId: null },
  );

  setSystemTime(new Date(startedAt + TURN_FINISHED_REPLAY_TTL_MS - 1));
  const restarted = createTurnFinishedStore(directory);
  expect(restarted.read("agent", "conversation")?.terminals[0]?.id).toBe(
    terminal.id,
  );
});

test("terminal replay expires at 24 hours and removes an empty scope file", () => {
  const directory = temporaryDirectory();
  const startedAt = Date.UTC(2026, 0, 1);
  setSystemTime(new Date(startedAt));
  createTurnFinishedStore(directory).put("agent", "conversation", {
    type: "turn_finished",
    turn_id: "expired",
    stop_reason: "end_turn",
  });
  const recordPath = join(
    directory,
    `${encodeTurnFinishedScope("agent", "conversation")}.json`,
  );
  expect(existsSync(recordPath)).toBe(true);

  setSystemTime(new Date(startedAt + TURN_FINISHED_REPLAY_TTL_MS));
  expect(
    createTurnFinishedStore(directory).read("agent", "conversation"),
  ).toBeNull();
  expect(existsSync(recordPath)).toBe(false);
});

test("expired terminals free the preserved 64-record capacity", () => {
  const directory = temporaryDirectory();
  const startedAt = Date.UTC(2026, 0, 1);
  setSystemTime(new Date(startedAt));
  const first = createTurnFinishedStore(directory);
  for (let index = 0; index < 64; index += 1) {
    first.put(
      "agent",
      "conversation",
      {
        type: "turn_finished",
        turn_id: `old-${index}`,
        stop_reason: "end_turn",
      },
      { connectionId: "owner", canRotate: false, lineageId: null },
    );
  }

  setSystemTime(new Date(startedAt + TURN_FINISHED_REPLAY_TTL_MS));
  const fresh = createTurnFinishedStore(directory).put(
    "agent",
    "conversation",
    { type: "turn_finished", turn_id: "fresh", stop_reason: "end_turn" },
    { connectionId: "owner", canRotate: false, lineageId: null },
  );
  expect(fresh.message.turn_id).toBe("fresh");
  expect(
    createTurnFinishedStore(directory)
      .read("agent", "conversation")
      ?.terminals.map((terminal) => terminal.message.turn_id),
  ).toEqual(["fresh"]);
});

test("completed-work removal rejection cannot escape terminal cleanup", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent", "conversation");
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  expect(() =>
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      conversationId: "conversation",
      forgetWork: () => {
        throw new Error("unlink failed");
      },
    }),
  ).not.toThrow();
  expect(runtime.turnLifecycle.kind).toBe("idle");
});

test("scope tuple encoding cannot collide through separators or null", () => {
  const scopes = [
    encodeTurnFinishedScope(null, "agent-a_conversation-b"),
    encodeTurnFinishedScope("a", "conversation-b"),
    encodeTurnFinishedScope("a_b", "conversation-b"),
    encodeTurnFinishedScope("null", "agent-a_conversation-b"),
  ];
  expect(new Set(scopes).size).toBe(scopes.length);
});

test("the explicit terminal application acknowledgement parses inbound", () => {
  expect(
    parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "turn_finished_ack",
          runtime: { agent_id: null, conversation_id: "conversation" },
          idempotency_key: "turn_finished:stable",
        }),
      ),
    ),
  ).toEqual({
    type: "turn_finished_ack",
    runtime: { agent_id: null, conversation_id: "conversation" },
    idempotency_key: "turn_finished:stable",
  });
  expect(
    parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "turn_finished_ack",
          runtime: { agent_id: null, conversation_id: "conversation" },
          idempotency_key: "x".repeat(257),
        }),
      ),
    ),
  ).toBeNull();
});

test("delivery claims are atomic across stores and retain one stable identity", () => {
  const directory = temporaryDirectory();
  const first = createTurnFinishedStore(directory);
  const second = createTurnFinishedStore(directory);
  const terminal = first.put(
    "agent",
    "conversation",
    { type: "turn_finished", turn_id: "turn", stop_reason: "end_turn" },
    { connectionId: "owner", canRotate: false, lineageId: null },
  );
  expect(first.claim("agent", "conversation", terminal.id, "owner")?.id).toBe(
    terminal.id,
  );
  expect(
    second.claim("agent", "conversation", terminal.id, "owner"),
  ).toBeNull();
  expect(first.read("agent", "conversation")?.terminals[0]?.id).toBe(
    terminal.id,
  );
});

test("corrupt terminal records fail closed and are never overwritten", () => {
  const directory = temporaryDirectory();
  const recordPath = join(
    directory,
    `${encodeTurnFinishedScope("agent", "conversation")}.json`,
  );
  writeFileSync(recordPath, "{corrupt", { mode: 0o600 });
  const store = createTurnFinishedStore(directory);
  expect(() =>
    store.put("agent", "conversation", {
      type: "turn_finished",
      turn_id: "must-not-overwrite",
      stop_reason: "end_turn",
    }),
  ).toThrow();
  expect(readFileSync(recordPath, "utf8")).toBe("{corrupt");
});

test("record locks never evict a live paused owner and recover a dead owner", () => {
  const directory = temporaryDirectory();
  const recordPath = join(
    directory,
    `${encodeTurnFinishedScope("agent", "conversation")}.json`,
  );
  const lockPath = `${recordPath}.lock`;
  const ownersPath = `${lockPath}-owners`;
  mkdirSync(ownersPath, { recursive: true });
  const liveOwner = join(ownersPath, `${process.pid}-live.json`);
  writeFileSync(
    liveOwner,
    JSON.stringify({ token: "live", pid: process.pid, processStart: null }),
  );
  linkSync(liveOwner, lockPath);
  const store = createTurnFinishedStore(directory, { lockAttempts: 1 });
  expect(() =>
    store.put("agent", "conversation", {
      type: "turn_finished",
      turn_id: "blocked",
      stop_reason: "end_turn",
    }),
  ).toThrow("Timed out acquiring");
  expect(existsSync(lockPath)).toBe(true);

  rmSync(lockPath);
  rmSync(liveOwner);
  const deadOwner = join(ownersPath, "2147483647-dead.json");
  writeFileSync(
    deadOwner,
    JSON.stringify({
      token: "dead",
      pid: 2_147_483_647,
      processStart: "dead",
    }),
  );
  linkSync(deadOwner, lockPath);
  const recovered = createTurnFinishedStore(directory, { lockAttempts: 2 }).put(
    "agent",
    "conversation",
    {
      type: "turn_finished",
      turn_id: "recovered",
      stop_reason: "end_turn",
    },
  );
  expect(recovered.message.turn_id).toBe("recovered");
  expect(existsSync(lockPath)).toBe(false);
  expect(existsSync(deadOwner)).toBe(false);
});
