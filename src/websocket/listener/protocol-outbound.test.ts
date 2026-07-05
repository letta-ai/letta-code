import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { DequeuedBatch } from "@/queue/queue-runtime";
import type { DeviceStatus, StreamDeltaMessage } from "@/types/protocol_v2";
import {
  buildDeviceStatus,
  emitDequeuedUserMessage,
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

  send(data: string): void {
    this.sentPayloads.push(data);
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
    connectionId: "conn-1",
    connectionName: "test-listener",
    bootWorkingDirectory: process.cwd(),
    workingDirectoryByConversation: new Map(),
    permissionModeByConversation: new Map(),
    approvalRuntimeKeyByRequestId: new Map(),
    worktreeWatcherByConversation: new Map(),
    pendingExternalToolCalls: new Map(),
    eventSeqCounter: 0,
    conversationRuntimes: new Map(),
  } as unknown as ListenerRuntime;
  const runtime = {
    listener,
    agentId: "agent-1",
    conversationId: "conv-1",
    pendingApprovalResolvers: new Map(),
    recoveredApprovalState: null,
    isProcessing: false,
    currentToolset: null,
    currentToolsetPreference: "auto",
    currentLoadedTools: [],
    currentAvailableSkills: [],
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

describe("buildDeviceStatus", () => {
  test("includes assigned agent skill paths from the conversation runtime", () => {
    const { runtime } = createRuntime();
    runtime.key = "agent:agent-1::conversation:conv-1";
    runtime.currentAvailableSkills = [
      {
        id: "agent-development",
        name: "letta-development-guide",
        description: "Agent-scoped MemFS skill",
        path: "/tmp/.letta/agents/agent-1/memory/skills/agent-development/SKILL.md",
        source: "agent",
      },
    ];
    runtime.listener.conversationRuntimes.set(runtime.key, runtime);

    const status = buildDeviceStatus(runtime, {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    }) as DeviceStatus;

    expect(status.current_available_skills).toEqual(
      runtime.currentAvailableSkills,
    );
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
});
