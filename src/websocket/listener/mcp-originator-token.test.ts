import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
  mcpOriginatorTokenCount,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import { createBuffers } from "@/cli/helpers/accumulator";
import { clearExternalTools } from "@/tools/manager";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { consumeQueuedTurn } from "./queue";
import { setActiveRuntime } from "./runtime";
import { safeSocketSend } from "./socket-send";
import type { ListenerTransport } from "./transport";
import { createTurnCorrelation } from "./turn-correlation";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createTurnFinalizer } from "./turn-finalizer";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

class MockSocket {
  readyState = 1;
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function initializeMockConnection(
  listener: ListenerRuntime,
  socket: MockSocket,
): void {
  const connection = openListenerConnection({
    runtime: listener,
    connectionId: "conn-test",
    writer: socket as unknown as WebSocket,
    options: makeListenerOptions(),
  });
  markListenerConnectionInitialized(listener, "conn-test", connection);
  subscribeListenerConnection(listener, "conn-test", {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

function buildHandler(
  listener: ListenerRuntime,
  socket: MockSocket,
  processed: IncomingMessage[],
) {
  return createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: makeListenerOptions(),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend,
    runDetachedListenerTask: (_label, task) => {
      void task();
    },
    trackListenerError: (error) => {
      throw error;
    },
    processIncomingMessage: async (incoming) => {
      processed.push(incoming);
    },
  });
}

function inputFrame(payload: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: "req-1",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: {
        kind: "create_message",
        messages: [{ role: "user", content: "hello" }],
        ...payload,
      },
    }),
  );
}

afterEach(() => {
  clearMcpOriginatorTokens();
  clearExternalTools();
  setActiveRuntime(null);
});

describe("MCP originator token ingestion", () => {
  test("holds a delivered token in memory and carries only the id on the message", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    );

    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBe("sr-1");
    // The IncomingMessage rides the durable input ledger: the token value
    // must never appear anywhere on it.
    expect(JSON.stringify(processed[0])).not.toContain("mst_one.secret-a");
    expect("mcpOriginatorToken" in (processed[0] ?? {})).toBe(false);
  });

  test("stays inert when the delivery carries no token", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(inputFrame({}));

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("ignores a token delivered without its super run id", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(
      inputFrame({ mcp_originator_token: "mst_one.secret-a" }),
    );

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("an unattributed super run id rides along without a stored token", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    const processed: IncomingMessage[] = [];
    const handleMessage = buildHandler(listener, socket, processed);

    await handleMessage(inputFrame({ super_run_id: "sr-2" }));

    await waitFor(() => processed.length === 1);
    expect(processed[0]?.mcpOriginatorSuperRunId).toBe("sr-2");
    expect(mcpOriginatorTokenCount()).toBe(0);
  });
});

describe("MCP originator batch resolution", () => {
  function enqueueMessage(
    runtime: ReturnType<typeof getOrCreateScopedRuntime>,
    content: string,
    mcpOriginatorSuperRunId?: string,
  ): void {
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      ...(mcpOriginatorSuperRunId ? { mcpOriginatorSuperRunId } : {}),
      messages: [{ role: "user", content }],
    });
  }

  test("an originator-unanimous batch keeps its super run id", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second", "sr-1");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBe("sr-1");
  });

  test("a mixed-originator batch runs unattributed", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second", "sr-2");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
  });

  test("an unattributed member never borrows the batch's originator", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    // The attributed message arrives first and becomes the template; its id
    // must not leak into the merged turn through the template spread.
    enqueueMessage(runtime, "first", "sr-1");
    enqueueMessage(runtime, "second");

    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.mcpOriginatorSuperRunId).toBeUndefined();
  });
});

describe("MCP originator token lifecycle", () => {
  function buildFinalizer(mcpOriginatorSuperRunId: string) {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const transport: ListenerTransport = {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    const incoming: IncomingMessage = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      mcpOriginatorSuperRunId,
      messages: [{ role: "user", content: "hello" }],
    };
    const finalizer = createTurnFinalizer({
      runtime,
      turnLease: lease,
      socket: transport,
      ownership: createTurnDurabilityOwnership(),
      turnCorrelation: createTurnCorrelation(runtime, incoming, "batch-1"),
      buffers: createBuffers(),
      agentId: "agent-1",
      conversationId: "conv-1",
      mcpOriginatorSuperRunId,
    });
    return { finalizer, lease, runtime };
  }

  test("a terminal turn drops its run's held token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    const { finalizer } = buildFinalizer("sr-1");

    const transition = finalizer.finishTurn({
      stopReason: "end_turn",
      conversationId: "conv-1",
    });

    expect(transition.finished).toBe(true);
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Other runs' tokens are untouched.
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
  });

  test("a rejected terminal commit keeps the held token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    const { finalizer } = buildFinalizer("sr-1");
    // A fenced-out (stale owner) commit must not retire the run's token.
    const transition = finalizer.finishTurn({
      stopReason: "end_turn",
      conversationId: "conv-1",
      canCommit: () => false,
    });

    expect(transition.finished).toBe(false);
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
  });
});
