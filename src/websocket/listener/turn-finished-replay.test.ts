import { expect, test } from "bun:test";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { replaySubscribedConnectionState } from "./connection-state-sync";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "./lifecycle";
import { evictConversationRuntimeIfIdle, setActiveRuntime } from "./runtime";
import type { ListenerTransport, LocalTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime, StartListenerOptions } from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];
  open = true;

  isOpen(): boolean {
    return this.open;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const USAGE = { total_tokens: 42, step_count: 2 };

function turnFinishedFrames(sent: string[]): Record<string, unknown>[] {
  return sent
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((message) => message.type === "turn_finished");
}

/** Ends a turn while `socket` is the only transport and it is already closed. */
function finishTurnOnClosedSocket(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
): void {
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  expect(
    finishListenerTurn(runtime, lease, {
      turnId: "turn-1",
      stopReason: "end_turn",
      socket,
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      usage: USAGE,
    }).finished,
  ).toBe(true);
}

function connectionOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "local://cloud-relay",
    deviceId: "device-1",
    connectionName: connectionId,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

test("a turn that ends while the socket is closed keeps its turn_finished frame", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockTransport();
  socket.open = false;

  finishTurnOnClosedSocket(runtime, socket);

  expect(socket.sent).toEqual([]);
  expect(runtime.undeliveredTurnFinished).toEqual({
    type: "turn_finished",
    turn_id: "turn-1",
    stop_reason: "end_turn",
    run_id: "run-1",
    usage: USAGE,
  });
  // The runtime must survive until a connection can receive the frame.
  expect(evictConversationRuntimeIfIdle(runtime)).toBe(false);
  expect(listener.conversationRuntimes.get(runtime.key)).toBe(runtime);
});

test("a turn that ends on an open socket stores nothing", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockTransport();

  finishTurnOnClosedSocket(runtime, socket);

  expect(turnFinishedFrames(socket.sent)).toHaveLength(1);
  expect(runtime.undeliveredTurnFinished).toBeNull();
});

test("sync replay sends the kept turn_finished exactly once", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const closedSocket = new MockTransport();
  closedSocket.open = false;
  finishTurnOnClosedSocket(runtime, closedSocket);

  const transport = new MockTransport();
  const connectionId = "cloud-relay";
  openListenerConnection({
    runtime: listener,
    connectionId,
    writer: transport,
    options: connectionOptions(connectionId),
  });
  markListenerConnectionInitialized(listener, connectionId);
  const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
  const refreshGitContext = async (): Promise<void> => {};

  await replaySubscribedConnectionState(listener, transport, runtime, scope, {
    refreshGitContext,
  });

  expect(turnFinishedFrames(transport.sent)).toEqual([
    expect.objectContaining({
      type: "turn_finished",
      runtime: scope,
      turn_id: "turn-1",
      run_id: "run-1",
      stop_reason: "end_turn",
      usage: USAGE,
    }),
  ]);
  expect(runtime.undeliveredTurnFinished).toBeNull();
  // Nothing else holds the runtime, so delivery lets it go.
  expect(listener.conversationRuntimes.has(runtime.key)).toBe(false);

  transport.sent.length = 0;
  await replaySubscribedConnectionState(listener, transport, runtime, scope, {
    refreshGitContext,
  });
  expect(turnFinishedFrames(transport.sent)).toEqual([]);
});

test("a reconnecting Cloud listener connection receives the kept turn_finished", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const closedSocket = new MockTransport();
  closedSocket.open = false;
  finishTurnOnClosedSocket(runtime, closedSocket);

  const transport = new MockTransport();
  const options = connectionOptions("cloud-relay");
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  listener.processServicesStarted = true;
  setActiveRuntime(listener);
  try {
    await startConnectedListenerRuntime(
      listener,
      transport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        emitInitialState: false,
      },
    );
    expect(turnFinishedFrames(transport.sent)).toEqual([
      expect.objectContaining({
        turn_id: "turn-1",
        run_id: "run-1",
        stop_reason: "end_turn",
        usage: USAGE,
      }),
    ]);
    expect(runtime.undeliveredTurnFinished).toBeNull();
  } finally {
    stopRuntime(listener, true);
    setActiveRuntime(null);
  }
});
