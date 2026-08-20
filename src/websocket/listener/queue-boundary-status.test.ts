import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { StartListenerOptions } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-boundary-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-boundary-test",
    connectionName: "listener-boundary-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function queuedMessage(clientMessageId: string) {
  return {
    type: "message" as const,
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [
      {
        role: "user" as const,
        content: clientMessageId,
        client_message_id: clientMessageId,
      },
    ],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

afterEach(() => {
  setActiveRuntime(null);
});

// Queue frames are otherwise emitted only on change and loop frames only on
// transition, so a single lost frame leaves downstream status consumers stale
// until the next change happens to land (LET-11174). These tests pin the
// repair: every turn produces unconditional queue + loop snapshots at turn
// start and turn end, even when nothing about the queue changed in between.
test("a turn emits queue and loop snapshots at both boundaries even when the queue is unchanged", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockSocket();
  listener.socket = socket as unknown as WebSocket;
  setActiveRuntime(listener);

  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-turn"))).toBe(
    true,
  );

  let turnStartFrameCount = -1;
  let processedTurns = 0;
  scheduleQueuePump(
    runtime,
    socket as unknown as WebSocket,
    makeListenerOptions(),
    async () => {
      // Snapshot what was already emitted when the turn body begins. The
      // queue is unchanged from here to turn end: the end-boundary frames
      // must be new emissions, not leftovers of the dequeue transition.
      turnStartFrameCount = socket.sentPayloads.length;
      processedTurns += 1;
    },
  );
  await waitFor(() => processedTurns === 1 && !runtime.queuePumpActive);
  // The dequeue-transition frame rides a microtask; let it flush so the
  // assertion below counts every frame belonging to this turn.
  await Bun.sleep(5);

  const parsed = socket.sentPayloads.map(
    (payload) => JSON.parse(payload) as Record<string, unknown>,
  );
  const framesBeforeTurnBody = parsed.slice(0, turnStartFrameCount);
  const framesAfterTurnBody = parsed.slice(turnStartFrameCount);

  // Turn start boundary: an unconditional queue snapshot (empty queue, no
  // removal transitions — distinct from the dequeue-transition frame) and a
  // loop status frame were emitted before the turn body ran.
  expect(
    framesBeforeTurnBody.some(
      (frame) =>
        frame.type === "update_queue" &&
        Array.isArray(frame.queue) &&
        frame.queue.length === 0 &&
        Array.isArray(frame.removed) &&
        frame.removed.length === 0,
    ),
  ).toBe(true);
  expect(
    framesBeforeTurnBody.some((frame) => frame.type === "update_loop_status"),
  ).toBe(true);

  // Turn end boundary: the same unconditional snapshots fire again after the
  // turn body, despite zero queue changes since turn start.
  expect(
    framesAfterTurnBody.some(
      (frame) =>
        frame.type === "update_queue" &&
        Array.isArray(frame.queue) &&
        frame.queue.length === 0 &&
        Array.isArray(frame.removed) &&
        frame.removed.length === 0,
    ),
  ).toBe(true);
  expect(
    framesAfterTurnBody.some((frame) => frame.type === "update_loop_status"),
  ).toBe(true);
});

test("boundary snapshots carry the turn's runtime scope", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockSocket();
  listener.socket = socket as unknown as WebSocket;
  setActiveRuntime(listener);

  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-scope"))).toBe(
    true,
  );

  let processedTurns = 0;
  scheduleQueuePump(
    runtime,
    socket as unknown as WebSocket,
    makeListenerOptions(),
    async () => {
      processedTurns += 1;
    },
  );
  await waitFor(() => processedTurns === 1 && !runtime.queuePumpActive);
  await Bun.sleep(5);

  const queueFrames = socket.sentPayloads
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((frame) => frame.type === "update_queue");
  expect(queueFrames.length).toBeGreaterThanOrEqual(2);
  for (const frame of queueFrames) {
    expect(frame.runtime).toMatchObject({
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
  }
});
