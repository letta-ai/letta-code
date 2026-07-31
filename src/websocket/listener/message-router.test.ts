import { afterEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import { __testSetBackend, type Backend } from "@/backend/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { scheduleQueuePump } from "./queue";
import { getConversationRuntimeKey, setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

class RecordingHeadlessBackend extends FakeHeadlessBackend {
  readonly createConversationCalls: Array<{
    body: Parameters<Backend["createConversation"]>[0];
    options: Parameters<Backend["createConversation"]>[1];
    id: string;
  }> = [];

  override async createConversation(
    body: Parameters<Backend["createConversation"]>[0],
    options?: Parameters<Backend["createConversation"]>[1],
  ) {
    const conversation = await super.createConversation(body);
    this.createConversationCalls.push({ body, options, id: conversation.id });
    return conversation;
  }
}

class BlockingConversationBackend extends RecordingHeadlessBackend {
  private markStarted!: () => void;
  private releaseCreation!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly creationGate = new Promise<void>((resolve) => {
    this.releaseCreation = resolve;
  });

  release(): void {
    this.releaseCreation();
  }

  override async createConversation(
    body: Parameters<Backend["createConversation"]>[0],
    options?: Parameters<Backend["createConversation"]>[1],
  ) {
    this.markStarted();
    await this.creationGate;
    return super.createConversation(body, options);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

function getParsedRuntimeScopeForTest(parsed: unknown) {
  if (!parsed || typeof parsed !== "object" || !("runtime" in parsed)) {
    return null;
  }
  const runtime = (
    parsed as { runtime?: { agent_id?: unknown; conversation_id?: unknown } }
  ).runtime;
  if (
    typeof runtime?.agent_id !== "string" ||
    typeof runtime.conversation_id !== "string"
  ) {
    return null;
  }
  return {
    agent_id: runtime.agent_id,
    conversation_id: runtime.conversation_id,
  };
}

describe("listener message router ownership handoff", () => {
  afterEach(() => {
    __testSetBackend(null);
    setActiveRuntime(null);
  });

  test("resolves create_message conversation new to fresh conversations before dispatch", async () => {
    const backend = new RecordingHeadlessBackend();
    __testSetBackend(backend);
    const listener = createRuntime();
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    openListenerConnection({
      runtime: listener,
      connectionId: opts.connectionId,
      writer: socket as unknown as WebSocket,
      options: opts,
    });
    const processedTurns: IncomingMessage[] = [];
    const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
      processedTurns.push(incoming);
    });
    const getOrCreateScopedRuntimeMock = mock(
      (
        runtime: Parameters<typeof getOrCreateScopedRuntime>[0],
        agentId: Parameters<typeof getOrCreateScopedRuntime>[1],
        conversationId: Parameters<typeof getOrCreateScopedRuntime>[2],
      ) => getOrCreateScopedRuntime(runtime, agentId, conversationId),
    );
    const trackListenerError = mock(() => {});
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn: mock(async () => {}),
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: getParsedRuntimeScopeForTest,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: getOrCreateScopedRuntimeMock,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      trackListenerError,
      wireChannelIngress: async () => {},
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: {
            agent_id: "agent-1",
            conversation_id: "new",
            acting_user_id: "user-1",
          },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "first scheduled turn" }],
          },
        }),
      ),
    );
    await waitFor(() => processedTurns.length === 1);

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "new" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "second scheduled turn" }],
          },
        }),
      ),
    );
    await waitFor(() => processedTurns.length === 2);

    expect(trackListenerError).not.toHaveBeenCalled();
    expect(backend.createConversationCalls).toHaveLength(2);
    expect(backend.createConversationCalls[0]?.body).toMatchObject({
      agent_id: "agent-1",
    });
    expect(backend.createConversationCalls[0]?.options).toEqual({
      headers: { [ACTING_USER_ID_HEADER]: "user-1" },
    });
    expect(backend.createConversationCalls[1]?.body).toMatchObject({
      agent_id: "agent-1",
    });
    expect(backend.createConversationCalls[1]?.options).toBeUndefined();

    const firstConversationId = backend.createConversationCalls[0]?.id;
    const secondConversationId = backend.createConversationCalls[1]?.id;
    expect(firstConversationId).toBeTruthy();
    expect(secondConversationId).toBeTruthy();
    expect(firstConversationId).not.toBe("new");
    expect(secondConversationId).not.toBe("new");
    expect(secondConversationId).not.toBe(firstConversationId);
    expect(processedTurns.map((turn) => turn.conversationId)).toEqual([
      firstConversationId,
      secondConversationId,
    ]);
    expect(
      getOrCreateScopedRuntimeMock.mock.calls.map((call) => call[2]),
    ).toEqual([firstConversationId, secondConversationId]);
    expect(
      listener.connectionIdsByRuntimeKey.has(
        getConversationRuntimeKey("agent-1", "new"),
      ),
    ).toBe(false);
    expect(
      listener.connectionIdsByRuntimeKey
        .get(getConversationRuntimeKey("agent-1", firstConversationId))
        ?.has(opts.connectionId),
    ).toBe(true);
    expect(
      listener.connectionIdsByRuntimeKey
        .get(getConversationRuntimeKey("agent-1", secondConversationId))
        ?.has(opts.connectionId),
    ).toBe(true);
  });

  test("does not dispatch a resolved new conversation after runtime replacement", async () => {
    const backend = new BlockingConversationBackend();
    __testSetBackend(backend);
    const listener = createRuntime();
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    openListenerConnection({
      runtime: listener,
      connectionId: opts.connectionId,
      writer: socket as unknown as WebSocket,
      options: opts,
    });
    const processIncomingMessage = mock(async () => {});
    const getOrCreateScopedRuntimeMock = mock(
      (
        runtime: Parameters<typeof getOrCreateScopedRuntime>[0],
        agentId: Parameters<typeof getOrCreateScopedRuntime>[1],
        conversationId: Parameters<typeof getOrCreateScopedRuntime>[2],
      ) => getOrCreateScopedRuntime(runtime, agentId, conversationId),
    );
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn: mock(async () => {}),
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: getParsedRuntimeScopeForTest,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: getOrCreateScopedRuntimeMock,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      trackListenerError: mock(() => {}),
      wireChannelIngress: async () => {},
      processIncomingMessage,
    });

    const handling = handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "new" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "superseded scheduled turn" }],
          },
        }),
      ),
    );
    await backend.started;
    setActiveRuntime(null);
    backend.release();
    await handling;

    expect(backend.createConversationCalls).toHaveLength(1);
    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(getOrCreateScopedRuntimeMock).not.toHaveBeenCalled();
    expect(listener.connectionIdsByRuntimeKey.size).toBe(0);
  });

  test("keeps explicit and default create_message conversation ids unchanged", async () => {
    const backend = new RecordingHeadlessBackend();
    __testSetBackend(backend);
    const listener = createRuntime();
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    const processedTurns: IncomingMessage[] = [];
    const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
      processedTurns.push(incoming);
    });
    const getOrCreateScopedRuntimeMock = mock(
      (
        runtime: Parameters<typeof getOrCreateScopedRuntime>[0],
        agentId: Parameters<typeof getOrCreateScopedRuntime>[1],
        conversationId: Parameters<typeof getOrCreateScopedRuntime>[2],
      ) => getOrCreateScopedRuntime(runtime, agentId, conversationId),
    );
    const trackListenerError = mock(() => {});
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn: mock(async () => {}),
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: getParsedRuntimeScopeForTest,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: getOrCreateScopedRuntimeMock,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      trackListenerError,
      wireChannelIngress: async () => {},
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "conv-explicit" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "explicit" }],
          },
        }),
      ),
    );
    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "default" }],
          },
        }),
      ),
    );
    await waitFor(() => processedTurns.length === 2);

    expect(trackListenerError).not.toHaveBeenCalled();
    expect(backend.createConversationCalls).toHaveLength(0);
    expect(processedTurns.map((turn) => turn.conversationId)).toEqual([
      "conv-explicit",
      "default",
    ]);
    expect(
      getOrCreateScopedRuntimeMock.mock.calls.map((call) => call[2]),
    ).toEqual(["conv-explicit", "default"]);
  });

  test("a direct message that loses the idle race is queued and later drained", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    const processIncomingMessage = mock(async () => {});
    const processedTurns: IncomingMessage[] = [];
    const processQueuedTurn = mock(async (queuedTurn: IncomingMessage) => {
      processedTurns.push(queuedTurn);
    });
    const trackListenerError = mock(() => {});
    let releaseMessageQueue!: () => void;
    runtime.messageQueue = new Promise<void>((resolve) => {
      releaseMessageQueue = resolve;
    });
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      trackListenerError,
      wireChannelIngress: async () => {},
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "do not drop me" }],
          },
        }),
      ),
    );
    const recoveryLease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });

    releaseMessageQueue();
    await runtime.messageQueue;
    await waitFor(
      () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
    );

    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(trackListenerError).not.toHaveBeenCalled();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queuedMessagesByItemId.size).toBe(1);

    runtime.turnLifecycle.finish(recoveryLease, "end_turn");
    scheduleQueuePump(
      runtime,
      socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
    );
    await waitFor(
      () => processedTurns.length === 1 && runtime.queueRuntime.length === 0,
    );

    expect(processedTurns[0]?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "do not drop me" }],
      },
    ]);
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
  });
});
