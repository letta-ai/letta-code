import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { stopLocalSubagent } from "@/tools/impl/subagent-stop-bridge";
import * as wakes from "@/tools/impl/wake";
import { handleQueueCommand } from "./commands/queue";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

afterEach(() => setActiveRuntime(null));

test.each(["new user message", "resume_queue"])(
  "a stopped child's parked user message resumes through %s",
  async (resumeWith) => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const scope = { agent_id: "agent-child", conversation_id: "conv-child" };
    const child = getOrCreateScopedRuntime(
      listener,
      scope.agent_id,
      scope.conversation_id,
    );
    const lease = child.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    child.turnLifecycle.setRunId(lease, "run-child");
    const transport = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: () => {},
    });
    const socket = transport as unknown as WebSocket;
    const opts: StartListenerOptions = {
      connectionId: "conn-stop-queue",
      wsUrl: "ws://listener.test",
      deviceId: "device-test",
      connectionName: "stop-queue-test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const processed: IncomingMessage[] = [];
    const processQueuedTurn = mock(async (incoming: IncomingMessage) => {
      processed.push(incoming);
    });
    const enqueue = (text: string) =>
      enqueueInboundUserMessage(child, {
        type: "message",
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
        messages: [{ role: "user", content: text }],
      });
    expect(enqueue("queued before stop")).toBe(true);
    child.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: "old poller",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
    });
    const cancelWakes = spyOn(
      wakes,
      "cancelConversationWakes",
    ).mockResolvedValue();
    createListenerMessageHandler({
      runtime: listener,
      socket,
      opts,
      processQueuedTurn,
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime,
      handleApprovalResponseInput: async () => {},
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: (runtime, params) =>
        handleAbortMessageInput(runtime, params, {
          cancelRun: async () => {
            child.turnLifecycle.finish(lease, "cancelled");
          },
          emitRuntimeStateUpdates: () => {},
          emitInterruptedStatusDelta: () => {},
        }),
      stampInboundUserMessageOtids: () => {},
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      trackListenerError: () => {},
    });
    try {
      expect(
        await stopLocalSubagent(opts.connectionId, {
          type: "subagent_stop",
          request_id: "stop",
          runtime: scope,
          agent_id: scope.agent_id,
          conversation: scope,
        }),
      ).toMatchObject({
        success: true,
        stopped: true,
        cleanup_confirmed: true,
      });
      // The real abort's finally pump runs, but a stop does not resume old work.
      await child.messageQueue;
      expect(child.turnLifecycle.kind).toBe("idle");
      expect(processed).toHaveLength(0);
      expect(child.queueRuntime.length).toBe(1);
      expect(child.queueRuntime.pausedCount).toBe(1);
      expect(cancelWakes).toHaveBeenCalledTimes(1);
      if (resumeWith === "new user message") {
        expect(enqueue("typed after stop")).toBe(true);
        scheduleQueuePump(child, socket, opts, processQueuedTurn);
      } else {
        handleQueueCommand(
          { type: "resume_queue", runtime: scope, request_id: "resume" },
          {
            listener,
            socket,
            opts,
            processQueuedTurn,
            getOrCreateScopedRuntime,
            safeSocketSend: () => true,
          },
        );
      }
      await child.messageQueue;
      expect(child.queueRuntime.pausedCount).toBe(0);
      expect(child.queueRuntime.length).toBe(0);
      expect(processed).toHaveLength(1);
      const content = JSON.stringify(processed[0]?.messages);
      expect(content).toContain("queued before stop");
      expect(content).not.toContain("old poller");
      if (resumeWith === "new user message")
        expect(content).toContain("typed after stop");
    } finally {
      cancelWakes.mockRestore();
      transport.emit("close");
    }
  },
);
