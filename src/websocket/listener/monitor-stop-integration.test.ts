import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

afterEach(() => {
  setActiveRuntime(null);
  for (const id of backgroundProcesses.keys())
    clearBackgroundProcessCleanup(id);
  backgroundProcesses.clear();
});

for (const busy of [false, true])
  test(`wire cancellation uses the normal notification queue while ${busy ? "busy" : "idle"}`, async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const target = getOrCreateScopedRuntime(listener, "agent-a", "default");
    if (busy) target.turnLifecycle.startCommand();
    const sent: unknown[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (text: string) => sent.push(JSON.parse(text)),
    } as unknown as WebSocket;
    const opts: StartListenerOptions = {
      connectionId: "connection-a",
      wsUrl: "wss://example.test/ws",
      deviceId: "device-a",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    };
    const delivered: IncomingMessage[] = [];
    let onDelivered!: () => void;
    const deliveredPromise = new Promise<void>((resolve) => {
      onDelivered = resolve;
    });
    const processQueuedTurn = async (incoming: IncomingMessage) => {
      delivered.push(incoming);
      onDelivered();
    };
    installProcessEventRouting({
      runtime: listener,
      processTransport: socket,
      opts,
      processQueuedTurn,
    });
    backgroundProcesses.set("monitor-wire", {
      kind: "monitor",
      description: "CI results",
      command: "wait",
      process: { kill() {} },
      status: "running",
      exitCode: null,
      runtimeScope: { agentId: "agent-a", conversationId: "default" },
      stdout: [],
      stderr: [],
      lastReadIndex: { stdout: 0, stderr: 0 },
    });
    const handler = createListenerMessageHandler({
      runtime: listener,
      socket,
      opts,
      processQueuedTurn,
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => target,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (input) => input,
      safeSocketSend: (_socket, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask() {},
      trackListenerError() {},
    });
    try {
      if (busy) {
        enqueueInboundUserMessage(
          target,
          {
            type: "message",
            agentId: "agent-a",
            conversationId: "default",
            messages: [{ role: "user", content: "Also run the tests." }],
          },
          "human-a",
        );
      }
      const command = {
        type: "monitor_stop",
        request_id: "stop-1",
        process_id: "monitor-wire",
        runtime: {
          agent_id: "agent-a",
          conversation_id: "default",
          acting_user_id: "human-a",
        },
      };
      await handler(Buffer.from(JSON.stringify(command)));
      expect(sent).toContainEqual({
        ...command,
        type: "monitor_stop_response",
        success: true,
        stopped: true,
      });
      if (busy) {
        expect(delivered).toHaveLength(0);
        expect(target.queueRuntime.length).toBe(2);
        expect(target.queueRuntime.peek()[1]).toMatchObject({
          kind: "task_notification",
          actingUserId: "human-a",
        });
        target.turnLifecycle.finishCommand();
        scheduleQueuePump(target, socket, opts, processQueuedTurn);
      }
      await deliveredPromise;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.actingUserId).toBe("human-a");
      expect(delivered[0]?.messages[0]).toMatchObject({ role: "user" });
      const content = JSON.stringify(delivered[0]?.messages);
      expect(content).toContain("The user cancelled this Monitor.");
      expect(content).toContain("monitor-wire");
      expect(content).not.toContain("Notice ID:");
      if (busy) expect(content).toContain("Also run the tests.");
      await handler(
        Buffer.from(JSON.stringify({ ...command, request_id: "stop-2" })),
      );
      expect(sent).toContainEqual({
        ...command,
        type: "monitor_stop_response",
        request_id: "stop-2",
        success: true,
        stopped: false,
      });
      expect(delivered).toHaveLength(1);
    } finally {
      clearProcessServices(listener);
    }
  });
