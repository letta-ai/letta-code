import { expect, test } from "bun:test";
import WebSocket from "ws";
import { createBuffers } from "@/cli/helpers/accumulator";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { attachTerminalConsumerToLiveAcceptedInput } from "./input-disposition-ownership";
import {
  loadPreparedInputTerminals,
  prepareInputTerminal,
} from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  recordListenerWork,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { handleTeleportRequest } from "./teleport";
import { TeleportTerminalPreparedError } from "./teleport-terminal-transfer";
import { createTurnCorrelation } from "./turn-correlation";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createTurnFinalizer } from "./turn-finalizer";
import {
  createTurnFinishedStore,
  replayPendingTurnFinishedToConnection,
} from "./turn-finished-replay";
import type { IncomingMessage, StartListenerOptions } from "./types";

const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conversation-1";
const SLACK_CONSUMER = "slack:agent-1";

class MockSocket {
  readonly bufferedAmount = 0;
  readonly readyState = WebSocket.OPEN;
  readonly sent: Array<{ type: string; [key: string]: unknown }> = [];

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

/**
 * Drive a Slack-originated source turn through the production finalizer while
 * a teleport is pending, and return the frames the source connection emitted.
 */
function yieldSourceTurnToTeleport(
  drained: boolean,
  lateDuplicate = false,
  durableListener = true,
  forceTerminalStoreFailure = false,
) {
  const listener = createRuntime();
  listener.connectionId = durableListener ? "conn-source" : "source";
  const runtime = getOrCreateScopedRuntime(listener, AGENT_ID, CONVERSATION_ID);
  const socket = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "source",
    writer: socket as never,
    options: makeOptions(),
  });
  subscribeListenerConnection(listener, "source", {
    agent_id: AGENT_ID,
    conversation_id: CONVERSATION_ID,
  });
  markListenerConnectionInitialized(listener, "source");
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  runtime.activeConnectionId = "source";
  const revision = recordListenerWork(
    runtime,
    { runId: "run-source", terminalConsumerIds: [SLACK_CONSUMER] },
    "run_observed",
  );
  const identity = ordinaryInputIdentity("cm-source");
  const admission = reserveInputDisposition(runtime, identity);
  if (admission.kind !== "reserved") throw new Error("expected reservation");
  expect(
    commitInputDisposition(runtime, admission.reservation, "started", {
      incoming: {
        type: "message",
        agentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
        messages: [],
        terminalConsumerIds: [SLACK_CONSUMER],
      },
    }),
  ).toBe(true);
  if (drained) runtime.pendingTurns = 1;
  handleTeleportRequest({
    listener,
    connectionId: "source",
    command: {
      type: "teleport_request",
      request_id: "teleport-1",
      teleport_id: "teleport-1",
      runtime: { agent_id: AGENT_ID, conversation_id: CONVERSATION_ID },
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    },
  });
  if (lateDuplicate) {
    expect(
      attachTerminalConsumerToLiveAcceptedInput(
        runtime,
        identity,
        "slack:recovery",
      ),
    ).toBe(true);
  }
  if (drained) runtime.pendingTurns = 0;
  const incoming: IncomingMessage = {
    type: "message",
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    terminalConsumerIds: [SLACK_CONSUMER],
    durableInputIdentities: identity ? [identity] : [],
    messages: [{ role: "user", content: "reply in the Slack thread" }],
  };
  const ownership = createTurnDurabilityOwnership();
  ownership.recordInput(incoming);
  const finalizer = createTurnFinalizer({
    runtime,
    turnLease: lease,
    socket: socket as never,
    ownership,
    turnCorrelation: createTurnCorrelation(runtime, incoming, "batch-1"),
    buffers: createBuffers(AGENT_ID),
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    interruptedRevisionRef: { current: revision },
  });
  if (forceTerminalStoreFailure) {
    const store = createTurnFinishedStore();
    for (let index = 0; index < 64; index += 1) {
      store.put(
        AGENT_ID,
        CONVERSATION_ID,
        {
          type: "turn_finished",
          turn_id: `capacity-${index}`,
          stop_reason: "end_turn",
          terminal_consumer_ids: [`capacity:${index}`],
        },
        {
          connectionId: `capacity-${index}`,
          canRotate: false,
          lineageId: `capacity-${index}`,
        },
      );
    }
    expect(() =>
      finalizer.finishTurn({
        stopReason: "cancelled",
        agentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
      }),
    ).toThrow(TeleportTerminalPreparedError);
    return { listener, runtime, socket };
  }
  const transition = finalizer.finishTurn({
    stopReason: drained ? "end_turn" : "cancelled",
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
  });
  expect(transition.finished).toBe(true);
  expect(runtime.turnLifecycle.kind).toBe("idle");
  return { listener, runtime, socket };
}

test("a post-prepare terminal-store failure preserves transferred ownership", () => {
  withTemporaryHome(() => {
    const { listener } = yieldSourceTurnToTeleport(false, true, true, true);
    const interrupted = createInterruptedTurnStore().read(
      AGENT_ID,
      CONVERSATION_ID,
    );
    expect(interrupted?.teleport?.teleportId).toBe("teleport-1");
    expect(interrupted?.teleport?.continuation?.terminal_consumer_ids).toEqual([
      SLACK_CONSUMER,
      "slack:recovery",
    ]);
    expect(
      loadPreparedInputTerminals(listener)[0]?.message.terminal_consumer_ids,
    ).toBeUndefined();
  });
});

function withTemporaryHome(run: () => void): void {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  try {
    run();
  } finally {
    createInterruptedTurnStore().remove(AGENT_ID, CONVERSATION_ID);
    directory.cleanup();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

test("an active-turn teleport handoff publishes readiness without a source turn_finished", () => {
  withTemporaryHome(() => {
    const { runtime, socket } = yieldSourceTurnToTeleport(false, true);
    const types = socket.sent.map((message) => message.type);

    // Channel gateways retire the turn's delivery on turn_finished. The turn
    // continues on the destination, so the source must hand off without one.
    expect(types).toContain("teleport_ready");
    expect(types).not.toContain("turn_finished");
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        teleport_id: "teleport-1",
        success: true,
        active_turn: true,
        continuation: {
          approvals: [],
          terminal_consumer_ids: [SLACK_CONSUMER, "slack:recovery"],
        },
      }),
    );

    // Nothing durable is left to replay as a terminal on a later reconnect.
    expect(
      createTurnFinishedStore().read(AGENT_ID, CONVERSATION_ID)?.terminals ??
        [],
    ).toEqual([]);
    socket.sent.length = 0;
    replayPendingTurnFinishedToConnection(socket as never, runtime, "source");
    expect(socket.sent).toEqual([]);

    const unavailable = yieldSourceTurnToTeleport(false, false, false).socket;
    expect(unavailable.sent).toContainEqual(
      expect.objectContaining({
        type: "turn_finished",
        terminal_consumer_ids: [SLACK_CONSUMER],
      }),
    );
    expect(unavailable.sent).not.toContainEqual(
      expect.objectContaining({ type: "teleport_ready" }),
    );
  });
});

test("a drained teleport still reports the finished turn before readiness", () => {
  withTemporaryHome(() => {
    const { socket } = yieldSourceTurnToTeleport(true);
    const types = socket.sent.map((message) => message.type);
    const finishedIndex = types.indexOf("turn_finished");
    const readyIndex = types.indexOf("teleport_ready");

    expect(finishedIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(finishedIndex);
    expect(socket.sent[finishedIndex]).toMatchObject({
      stop_reason: "end_turn",
      terminal_consumer_ids: [SLACK_CONSUMER],
    });
    expect(socket.sent[readyIndex]).toMatchObject({ active_turn: false });
  });
});

test("restart promotion keeps transferred consumers off the source terminal", () => {
  withTemporaryHome(() => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    const identity = ordinaryInputIdentity("cm-crash-handoff");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: {
          type: "message",
          agentId: AGENT_ID,
          conversationId: CONVERSATION_ID,
          messages: [],
          terminalConsumerIds: [SLACK_CONSUMER, "slack:recovery"],
        },
      }),
    ).toBe(true);
    expect(
      prepareInputTerminal(runtime, identity ? [identity] : [], {
        scope: { agentId: AGENT_ID, conversationId: CONVERSATION_ID },
        message: {
          type: "turn_finished",
          turn_id: "turn-crash-handoff",
          stop_reason: "cancelled",
          terminal_consumer_ids: [SLACK_CONSUMER, "slack:recovery"],
        },
        owner: {
          connectionId: "source",
          canRotate: false,
          lineageId: "source",
        },
        persistWithoutConsumers: true,
        suppressConsumerPublication: true,
      }),
    ).toBe(true);
    const terminalStore = createTurnFinishedStore();
    restoreDurableQueuedInputs(listener, terminalStore);

    expect(
      terminalStore.read(AGENT_ID, CONVERSATION_ID)?.terminals[0]?.message,
    ).toEqual({
      type: "turn_finished",
      turn_id: "turn-crash-handoff",
      stop_reason: "cancelled",
    });
  });
});
