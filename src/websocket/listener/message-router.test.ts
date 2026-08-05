import { afterEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import {
  clearExternalTools,
  prepareToolExecutionContextForModel,
} from "@/tools/manager";
import { CHANNEL_SERVICE_COMMAND_TYPES } from "@/types/service-protocol";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

describe("listener message router ownership handoff", () => {
  afterEach(() => {
    clearExternalTools();
    setActiveRuntime(null);
  });

  test("acknowledges batched external-tool registration without runtime startup", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const sent: unknown[] = [];
    setActiveRuntime(listener);
    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: makeListenerOptions(),
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "runtime_external_tools_update",
          request_id: "tools-1",
          updates: [
            {
              runtimes: [{ agent_id: "agent-1", conversation_id: "conv-1" }],
              external_tools: [
                {
                  tools: [
                    {
                      name: "MessageChannel",
                      description: "Deliver a channel message",
                      parameters: { type: "object", properties: {} },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(sent).toEqual([
      {
        type: "runtime_external_tools_update_response",
        request_id: "tools-1",
        success: true,
      },
    ]);
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["MessageChannel"],
        runtimeContext: {
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      },
    );
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "MessageChannel",
    ]);
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
    const sent: unknown[] = [];
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
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError,
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-race",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "do not drop me",
                client_message_id: "cm-input-race",
              },
            ],
          },
        }),
      ),
    );
    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-race-retry",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "do not drop me",
                client_message_id: "cm-input-race",
              },
            ],
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
        client_message_id: "cm-input-race",
      },
    ]);
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-race",
        accepted: true,
        disposition: "queued",
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-race-retry",
        accepted: true,
        disposition: "queued",
      }),
    );
  });

  test("acknowledges a directly-owned input as started and deduplicates retries", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const sent: unknown[] = [];
    const processIncomingMessage = mock(async () => {});
    setActiveRuntime(listener);
    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts: makeListenerOptions(),
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-direct",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "start now",
                client_message_id: "cm-input-direct",
              },
            ],
          },
        }),
      ),
    );
    await runtime.messageQueue;

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          request_id: "input-direct-retry",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: "start now",
                client_message_id: "cm-input-direct",
              },
            ],
          },
        }),
      ),
    );
    await runtime.messageQueue;

    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-direct",
        accepted: true,
        disposition: "started",
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        request_id: "input-direct-retry",
        accepted: true,
        disposition: "started",
      }),
    );
  });

  test("delegates registered service commands and returns their protocol messages", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    const response = {
      type: "channel_routes_list_response" as const,
      request_id: "routes-1",
      success: true,
      routes: [],
    };
    const serviceCommandHandler = mock(async () => ({
      kind: "protocol" as const,
      messages: [response],
    }));
    listener.serviceCommandTypes = new Set(CHANNEL_SERVICE_COMMAND_TYPES);
    listener.serviceCommandHandler = serviceCommandHandler;
    const sent: unknown[] = [];
    const detachedTasks: Promise<void>[] = [];
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => runtime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_target, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask: (_label, task) => {
        detachedTasks.push(task());
      },
      trackListenerError: () => {},
      processIncomingMessage: async () => {},
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "channel_routes_list",
          request_id: "routes-1",
          channel_id: "telegram",
        }),
      ),
    );
    await Promise.all(detachedTasks);

    expect(serviceCommandHandler).toHaveBeenCalledWith({
      kind: "protocol",
      command: {
        type: "channel_routes_list",
        request_id: "routes-1",
        channel_id: "telegram",
      },
    });
    expect(sent).toEqual([response]);
  });
});
