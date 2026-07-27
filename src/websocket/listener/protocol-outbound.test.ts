import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { DequeuedBatch } from "@/queue/queue-runtime";
import type { StreamDeltaMessage } from "@/types/protocol_v2";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
  TO_SUBSCRIBERS,
  toListenerConnection,
} from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime as createListenerRuntime } from "@/websocket/listener/lifecycle";
import { OUTBOUND_QUEUE_LIMITS } from "@/websocket/listener/outbound-wire";
import {
  emitDequeuedUserMessage,
  emitDeviceStatusUpdateIfChanged,
  emitProtocolV2Message,
} from "@/websocket/listener/protocol-outbound";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
} from "@/websocket/listener/types";

class MockSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sentPayloads: string[] = [];
  terminated = false;

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createRuntime(): {
  runtime: ConversationRuntime;
  socket: MockSocket;
} {
  const socket = new MockSocket();
  const listener = {
    socket: socket as never,
    transport: socket as never,
    streamTransport: null,
    eventSeqCounter: 0,
    conversationRuntimes: new Map(),
  } as unknown as ListenerRuntime;
  const runtime = {
    listener,
    agentId: "agent-1",
    conversationId: "conv-1",
  } as unknown as ConversationRuntime;
  listener.conversationRuntimes.set("test", runtime);
  return { runtime, socket };
}

function parseOnlyStreamDelta(socket: MockSocket): StreamDeltaMessage {
  expect(socket.sentPayloads).toHaveLength(1);
  const message = JSON.parse(socket.sentPayloads[0] ?? "{}");
  expect(message.type).toBe("stream_delta");
  return message as StreamDeltaMessage;
}

describe("emitProtocolV2Message backpressure", () => {
  test("never sheds stream deltas that snapshots cannot replay", () => {
    const { runtime, socket } = createRuntime();
    socket.bufferedAmount = OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES;

    for (let i = 0; i <= OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES; i += 1) {
      emitProtocolV2Message(
        socket as never,
        runtime,
        {
          type: "stream_delta",
          delta: {
            message_type: "assistant_message",
            content: `delta-${i}`,
          },
        } as never,
        undefined,
        TO_SUBSCRIBERS,
      );
    }

    expect(socket.terminated).toBe(true);
    expect(socket.sentPayloads).toEqual([]);
  });

  test("treats future protocol frame types as lossless by default", () => {
    const { runtime, socket } = createRuntime();
    socket.bufferedAmount = OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES;

    for (let i = 0; i <= OUTBOUND_QUEUE_LIMITS.MAX_QUEUED_FRAMES; i += 1) {
      emitProtocolV2Message(
        socket as never,
        runtime,
        {
          type: "future_protocol_message",
          content: `frame-${i}`,
        } as never,
        undefined,
        TO_SUBSCRIBERS,
      );
    }

    expect(socket.terminated).toBe(true);
    expect(socket.sentPayloads).toEqual([]);
  });
});

describe("emitProtocolV2Message connection routing", () => {
  test("fans notifications out to subscribers and honors an explicit target", () => {
    const listener = createListenerRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    const socketC = new MockSocket();
    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };

    for (const [connectionId, socket] of [
      ["client-a", socketA],
      ["client-b", socketB],
      ["client-c", socketC],
    ] as const) {
      openListenerConnection({
        runtime: listener,
        connectionId,
        writer: socket as never,
        options: {
          connectionId,
          wsUrl: "ws://test",
          deviceId: "test",
          connectionName: connectionId,
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      });
      markListenerConnectionInitialized(listener, connectionId);
    }
    subscribeListenerConnection(listener, "client-a", scope);
    subscribeListenerConnection(listener, "client-b", scope);

    emitProtocolV2Message(
      socketC as never,
      runtime,
      {
        type: "update_loop_status",
        loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
      } as never,
      scope,
      TO_SUBSCRIBERS,
    );

    expect(socketA.sentPayloads).toHaveLength(1);
    expect(socketB.sentPayloads).toHaveLength(1);
    expect(socketC.sentPayloads).toHaveLength(0);

    emitProtocolV2Message(
      socketA as never,
      runtime,
      {
        type: "control_request",
        request_id: "approval-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: {},
          tool_call_id: "tool-1",
          permission_suggestions: [],
          blocked_path: null,
        },
      } as never,
      scope,
      toListenerConnection("client-b"),
    );

    expect(socketA.sentPayloads).toHaveLength(1);
    expect(socketB.sentPayloads).toHaveLength(2);
    expect(socketC.sentPayloads).toHaveLength(0);
  });

  test("drops scoped events when the scope has no subscribers", () => {
    const listener = createListenerRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    for (const [connectionId, socket] of [
      ["client-a", socketA],
      ["client-b", socketB],
    ] as const) {
      openListenerConnection({
        runtime: listener,
        connectionId,
        writer: socket as never,
        options: {
          connectionId,
          wsUrl: "ws://test",
          deviceId: "test",
          connectionName: connectionId,
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      });
      markListenerConnectionInitialized(listener, connectionId);
    }

    emitProtocolV2Message(
      socketA as never,
      runtime,
      {
        type: "update_queue",
        queue: [],
      } as never,
      { agent_id: "agent-1", conversation_id: "conv-1" },
      TO_SUBSCRIBERS,
    );

    expect(socketA.sentPayloads).toEqual([]);
    expect(socketB.sentPayloads).toEqual([]);
  });

  test("keeps cron and background snapshots inside their subscribed runtime", () => {
    const listener = createListenerRuntime();
    const runtimeA = getOrCreateScopedRuntime(listener, "agent-a", "conv-a");
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    for (const [connectionId, socket] of [
      ["client-a", socketA],
      ["client-b", socketB],
    ] as const) {
      openListenerConnection({
        runtime: listener,
        connectionId,
        writer: socket as never,
        options: {
          connectionId,
          wsUrl: "ws://test",
          deviceId: "test",
          connectionName: connectionId,
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      });
      markListenerConnectionInitialized(listener, connectionId);
    }
    subscribeListenerConnection(listener, "client-a", {
      agent_id: "agent-a",
      conversation_id: "conv-a",
    });
    subscribeListenerConnection(listener, "client-b", {
      agent_id: "agent-b",
      conversation_id: "conv-b",
    });

    emitProtocolV2Message(
      socketA as never,
      runtimeA,
      {
        type: "crons_updated",
        timestamp: 1,
        agent_id: "agent-a",
        conversation_id: "conv-a",
      } as never,
      { agent_id: "agent-a", conversation_id: "conv-a" },
      TO_SUBSCRIBERS,
    );
    emitProtocolV2Message(
      socketA as never,
      runtimeA,
      {
        type: "update_subagent_state",
        subagents: [],
      } as never,
      { agent_id: "agent-a", conversation_id: "conv-a" },
      TO_SUBSCRIBERS,
    );

    expect(socketA.sentPayloads).toHaveLength(2);
    expect(socketB.sentPayloads).toEqual([]);
  });
});

describe("emitDequeuedUserMessage", () => {
  test("emits cron_prompt-only turns as visible scheduled task user messages", () => {
    const { runtime, socket } = createRuntime();
    const cronText = [
      "<system-reminder>",
      'Scheduled task "Daily status" is firing.',
      "Description: Ask for the current status.",
      "This is fire #3 (cron: * * * * *).",
      "",
      "What changed since the last check-in?",
      "</system-reminder>",
    ].join("\n");
    const incoming = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: cronText }],
        },
      ],
    } as IncomingMessage;
    const batch = {
      batchId: "batch-cron",
      items: [
        {
          id: "item-cron",
          kind: "cron_prompt",
          source: "cron",
          text: cronText,
          cronTaskId: "task-1",
          agentId: "agent-1",
          conversationId: "conv-1",
          enqueuedAt: Date.now(),
        },
      ],
      mergedCount: 1,
      queueLenAfter: 0,
    } satisfies DequeuedBatch;

    emitDequeuedUserMessage(socket as never, runtime, incoming, batch);

    const message = parseOnlyStreamDelta(socket);
    expect(message.runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    const userDelta = message.delta as {
      message_type: string;
      content: unknown;
    };
    expect(userDelta.message_type).toBe("user_message");
    expect(userDelta.content).toEqual([
      {
        type: "text",
        text: [
          'Scheduled task "Daily status" is firing.',
          "This is fire #3 (cron: * * * * *).",
          "",
          "What changed since the last check-in?",
        ].join("\n"),
      },
    ]);
    expect(JSON.stringify(userDelta.content)).not.toContain(
      "<system-reminder>",
    );
    expect(JSON.stringify(userDelta.content)).not.toContain("Description:");
  });

  test("keeps ordinary pure system reminders hidden", () => {
    const { runtime, socket } = createRuntime();
    const hiddenReminder =
      "<system-reminder>Generated device context.</system-reminder>";
    const incoming = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: hiddenReminder }],
    } as IncomingMessage;
    const batch = {
      batchId: "batch-user",
      items: [
        {
          id: "item-user",
          kind: "message",
          source: "user",
          content: hiddenReminder,
          agentId: "agent-1",
          conversationId: "conv-1",
          enqueuedAt: Date.now(),
        },
      ],
      mergedCount: 1,
      queueLenAfter: 0,
    } satisfies DequeuedBatch;

    emitDequeuedUserMessage(socket as never, runtime, incoming, batch);

    expect(socket.sentPayloads).toHaveLength(0);
  });

  test("suppresses the echo for mod_continue-only turns", () => {
    const { runtime, socket } = createRuntime();
    const continueText = "keep going and double-check your work";
    const incoming = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: continueText }],
        },
      ],
    } as IncomingMessage;
    const batch = {
      batchId: "batch-continue",
      items: [
        {
          id: "item-continue",
          kind: "mod_continue",
          source: "system",
          text: continueText,
          agentId: "agent-1",
          conversationId: "conv-1",
          enqueuedAt: Date.now(),
        },
      ],
      mergedCount: 1,
      queueLenAfter: 0,
    } satisfies DequeuedBatch;

    emitDequeuedUserMessage(socket as never, runtime, incoming, batch);

    expect(socket.sentPayloads).toHaveLength(0);
  });
});

describe("emitDeviceStatusUpdateIfChanged", () => {
  test("normalizes runtime scopes without cross-scope leakage", () => {
    const listener = createListenerRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "default");
    const otherRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-2",
      "default",
    );
    const socket = new MockSocket();
    const otherSocket = new MockSocket();

    expect(emitDeviceStatusUpdateIfChanged(socket as never, runtime, {})).toBe(
      true,
    );
    expect(
      emitDeviceStatusUpdateIfChanged(socket as never, runtime, {
        agent_id: "agent-1",
        conversation_id: "default",
      }),
    ).toBe(false);
    expect(
      emitDeviceStatusUpdateIfChanged(socket as never, otherRuntime, {}),
    ).toBe(true);
    expect(
      emitDeviceStatusUpdateIfChanged(otherSocket as never, runtime, {}),
    ).toBe(true);

    expect(socket.sentPayloads).toHaveLength(2);
    expect(otherSocket.sentPayloads).toHaveLength(1);
  });
});
