import { afterEach, expect, mock, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { settingsManager } from "@/settings-manager";
import { closeListenerConnection, openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import {
  claimPendingTeleportAtBoundary,
  finishPendingTeleport,
  handleTeleportRequest,
  isRuntimeTeleportPending,
} from "./teleport";

class Socket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
}

afterEach(() => setActiveRuntime(null));

for (const boundary of ["idle", "active", "drained"] as const) {
  test.each(["closed", "removed"] as const)(
    `${boundary} teleport with %s source preserves work and admits later input`,
    async (disconnect) => {
      const listener = createRuntime();
      const agentId = `agent-teleport-test-${crypto.randomUUID()}`;
      const conversationId = "conversation-test";
      const runtime = getOrCreateScopedRuntime(
        listener,
        agentId,
        conversationId,
      );
      const socket = new Socket();
      const options = {
        connectionId: "conn-source",
        wsUrl: "ws://test",
        deviceId: "source",
        connectionName: "Source",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      };
      openListenerConnection({
        runtime: listener,
        connectionId: options.connectionId,
        writer: socket as never,
        options,
      });
      listener.connectionId = options.connectionId;
      setActiveRuntime(listener);
      const lease =
        boundary === "idle"
          ? null
          : runtime.turnLifecycle.begin({
              origin: "message",
              workingDirectory: process.cwd(),
            });
      if (boundary === "drained") {
        runtime.queueRuntime.enqueue({
          kind: "message",
          source: "user",
          content: "already accepted",
          clientMessageId: "accepted-before-teleport",
          agentId,
          conversationId,
        } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
      }
      const settings = spyOn(settingsManager, "getSettings").mockReturnValue(
        {} as ReturnType<typeof settingsManager.getSettings>,
      );
      const store = createInterruptedTurnStore();
      store.write({
        agentId,
        conversationId,
        runId: "run-saved",
        toolCallIds: ["tool-saved"],
        results: [
          {
            type: "tool",
            tool_call_id: "tool-saved",
            status: "success",
            tool_return: "saved result",
          },
        ],
        requestOtid: "saved-request",
        workingDirectory: process.cwd(),
      });
      const saved = store.read(agentId, conversationId);
      const disconnectSource = () => {
        socket.readyState = WebSocket.CLOSED;
        if (disconnect === "removed")
          closeListenerConnection(listener, options.connectionId);
      };
      try {
        if (boundary === "idle") disconnectSource();
        handleTeleportRequest({
          listener,
          connectionId: options.connectionId,
          command: {
            type: "teleport_request",
            request_id: "teleport-test",
            teleport_id: "teleport-test",
            runtime: { agent_id: agentId, conversation_id: conversationId },
            target: {
              connection_id: "target",
              device_id: "target",
              connection_name: "Target",
            },
          },
        });
        if (lease) {
          disconnectSource();
          expect(
            claimPendingTeleportAtBoundary({
              listener,
              agentId,
              conversationId,
              activeTurn: true,
            }),
          ).toBeNull();
          expect(runtime.turnLifecycle.isCurrent(lease)).toBe(true);
          expect(store.read(agentId, conversationId)).toEqual(saved);
          if (boundary === "drained") {
            expect(runtime.queueRuntime.length).toBe(1);
            runtime.turnLifecycle.finish(lease, "end_turn");
            finishPendingTeleport(runtime);
            expect(runtime.queueRuntime.length).toBe(1);
            runtime.queueRuntime.consumeItems(1);
            const queuedLease = runtime.turnLifecycle.begin({
              origin: "message",
              workingDirectory: process.cwd(),
            });
            runtime.turnLifecycle.finish(queuedLease, "end_turn");
            finishPendingTeleport(runtime);
          } else {
            runtime.turnLifecycle.finish(lease, "end_turn");
            finishPendingTeleport(runtime);
          }
        }
        expect(store.read(agentId, conversationId)).toEqual(saved);
        expect(
          socket.sent.some(
            (frame) => (frame as { type?: string }).type === "teleport_ready",
          ),
        ).toBe(false);
        if (disconnect === "closed")
          closeListenerConnection(listener, options.connectionId);
        const reconnected = new Socket();
        openListenerConnection({
          runtime: listener,
          connectionId: options.connectionId,
          writer: reconnected as never,
          options,
        });
        const processIncomingMessage = mock(async () => {});
        const onInputAccepted = mock(() => {});
        dispatchInboundMessageWhenReady({
          listener,
          runtime,
          incoming: {
            type: "message",
            agentId,
            conversationId,
            messages: [{ role: "user", content: "next task" }],
          },
          socket: reconnected as never,
          options,
          processIncomingMessage,
          processQueuedTurn: mock(async () => {}),
          trackListenerError: mock(() => {}),
          onInputAccepted,
        });
        await runtime.messageQueue;
        expect(onInputAccepted).toHaveBeenCalledWith({
          accepted: true,
          disposition: "started",
        });
        expect(processIncomingMessage).toHaveBeenCalledTimes(1);
        expect(
          isRuntimeTeleportPending(listener, agentId, conversationId),
        ).toBe(false);
      } finally {
        store.remove(agentId, conversationId);
        settings.mockRestore();
      }
    },
  );
}
