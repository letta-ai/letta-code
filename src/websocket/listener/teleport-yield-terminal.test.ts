import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  closeListenerConnection,
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import {
  claimPendingTeleportAtBoundary,
  finishClaimedTeleport,
  handleTeleportRequest,
} from "./teleport";
import {
  createTurnFinishedStore,
  replayPendingTurnFinishedToConnection,
} from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";
import type { ListenerRuntime, StartListenerOptions } from "./types";

class MockSocket {
  readonly bufferedAmount = 0;
  readonly readyState = WebSocket.OPEN;
  readonly sent: { type?: string; [key: string]: unknown }[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  types(): (string | undefined)[] {
    return this.sent.map((frame) => frame.type);
  }
}

const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conversation-1";
const SCOPE = { agent_id: AGENT_ID, conversation_id: CONVERSATION_ID };

function makeOptions(connectionId: string): StartListenerOptions {
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

function connect(
  listener: ListenerRuntime,
  connectionId: string,
  socket: MockSocket,
): void {
  openListenerConnection({
    runtime: listener,
    connectionId,
    writer: socket as never,
    options: makeOptions(connectionId),
  });
  subscribeListenerConnection(listener, connectionId, SCOPE);
  markListenerConnectionInitialized(listener, connectionId);
}

function requestTeleport(
  listener: ListenerRuntime,
  connectionId: string,
  requestId: string,
): void {
  handleTeleportRequest({
    listener,
    connectionId,
    command: {
      type: "teleport_request",
      request_id: requestId,
      teleport_id: "teleport-yield",
      runtime: SCOPE,
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    },
  });
}

/** Run an active Slack-delivered turn up to its teleport yield. */
function yieldActiveTurnToTeleport(params: {
  listener: ListenerRuntime;
  socket: MockSocket;
  canCommitReady: boolean;
}) {
  const { listener, socket } = params;
  listener.connectionId = "conn-source";
  listener.connectionGeneration = "generation-source";
  const runtime = getOrCreateScopedRuntime(listener, AGENT_ID, CONVERSATION_ID);
  connect(listener, "source", socket);
  runtime.activeConnectionId = "source";
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  requestTeleport(listener, "source", "teleport-request");
  const pending = claimPendingTeleportAtBoundary({
    listener,
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    activeTurn: true,
  });
  if (!pending) throw new Error("expected pending teleport");
  socket.sent.length = 0;
  const transition = finishClaimedTeleport(
    runtime,
    pending,
    (options) =>
      finishListenerTurn(runtime, lease, {
        ...options,
        socket: socket as never,
        turnId: "turn-teleport-yield",
        // Cloud's Slack gateway is a terminal consumer of this delivery.
        terminalConsumerIds: ["slack:agent-1"],
        canCommit: () => true,
      }),
    { canCommit: () => params.canCommitReady },
  );
  return { runtime, transition };
}

function withHome(run: () => void): void {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  try {
    run();
  } finally {
    createInterruptedTurnStore().remove(AGENT_ID, CONVERSATION_ID);
    const terminals = createTurnFinishedStore();
    for (const terminal of terminals.read(AGENT_ID, CONVERSATION_ID)
      ?.terminals ?? []) {
      terminals.remove(AGENT_ID, CONVERSATION_ID, terminal.id);
    }
    directory.cleanup();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

afterEach(() => {
  setActiveRuntime(null);
});

test("a teleport yield emits teleport_ready without any turn_finished", () => {
  withHome(() => {
    const listener = createRuntime();
    const socket = new MockSocket();
    const { runtime, transition } = yieldActiveTurnToTeleport({
      listener,
      socket,
      canCommitReady: true,
    });

    expect(transition.finished).toBe(true);
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(socket.types()).toContain("teleport_ready");
    expect(socket.types()).not.toContain("turn_finished");
    expect(
      createInterruptedTurnStore().read(AGENT_ID, CONVERSATION_ID)?.teleport,
    ).toMatchObject({ teleportId: "teleport-yield", ready: true });
    // Readiness retired the local proof; nothing remains to replay later.
    expect(
      createTurnFinishedStore().read(AGENT_ID, CONVERSATION_ID),
    ).toBeNull();
  });
});

test("a retained teleport-yield proof is never replayed as turn_finished after reconnect", () => {
  withHome(() => {
    const listener = createRuntime();
    const socket = new MockSocket();
    yieldActiveTurnToTeleport({ listener, socket, canCommitReady: false });

    expect(socket.types()).not.toContain("turn_finished");
    expect(socket.types()).not.toContain("teleport_ready");
    // The terminal is still durable local proof that the source turn ended,
    // without terminal consumers that would wait for a Cloud ACK.
    const proof = createTurnFinishedStore().read(AGENT_ID, CONVERSATION_ID)
      ?.terminals[0];
    expect(proof).toMatchObject({
      message: { type: "turn_finished", turn_id: "turn-teleport-yield" },
      owner: { teleportYield: true },
      requiredConsumerIds: [],
    });
    expect(proof?.message.terminal_consumer_ids).toBeUndefined();

    // A reconnecting owner replays pending terminals; the yield proof is skipped.
    closeListenerConnection(listener, "source");
    const reconnected = new MockSocket();
    connect(listener, "source", reconnected);
    const runtime = getOrCreateScopedRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    replayPendingTurnFinishedToConnection(
      reconnected as never,
      runtime,
      "source",
    );
    expect(reconnected.types()).not.toContain("turn_finished");

    // The same proof still authorizes readiness on the request retry.
    requestTeleport(listener, "source", "teleport-request-retry");
    expect(reconnected.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        teleport_id: "teleport-yield",
      }),
    );
    expect(reconnected.types()).not.toContain("turn_finished");
    expect(
      createInterruptedTurnStore().read(AGENT_ID, CONVERSATION_ID)?.teleport,
    ).toMatchObject({ ready: true });
    expect(
      createTurnFinishedStore().read(AGENT_ID, CONVERSATION_ID),
    ).toBeNull();
  });
});

test("replay skips only teleport-yield terminals", () => {
  withHome(() => {
    const store = createTurnFinishedStore();
    const listener = createRuntime();
    const socket = new MockSocket();
    connect(listener, "source", socket);
    const runtime = getOrCreateScopedRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    const owner = { connectionId: "source", canRotate: false, lineageId: null };
    store.put(
      AGENT_ID,
      CONVERSATION_ID,
      { type: "turn_finished", turn_id: "yielded", stop_reason: "cancelled" },
      { ...owner, terminalIdentity: "yielded", teleportYield: true },
    );
    store.put(
      AGENT_ID,
      CONVERSATION_ID,
      {
        type: "turn_finished",
        turn_id: "ordinary",
        stop_reason: "end_turn",
        terminal_consumer_ids: ["slack:agent-1"],
      },
      { ...owner, terminalIdentity: "ordinary" },
    );

    replayPendingTurnFinishedToConnection(
      socket as never,
      runtime,
      "source",
      store,
    );

    expect(
      socket.sent
        .filter((frame) => frame.type === "turn_finished")
        .map((frame) => frame.turn_id),
    ).toEqual(["ordinary"]);
    // Reading the record back validates the persisted marker shape.
    expect(
      store
        .readOrThrow(AGENT_ID, CONVERSATION_ID)
        ?.terminals.map((terminal) => terminal.owner.teleportYield ?? false),
    ).toEqual([true, false]);
  });
});
