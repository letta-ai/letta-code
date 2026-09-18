import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import {
  closeListenerConnection,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
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
import { handleIncomingMessage } from "./turn";

class Socket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
}

afterEach(() => setActiveRuntime(null));

test("a real local turn persists its reply after an unsent teleport is cleared", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "teleport-next-turn-"));
  const sync = spyOn(
    repositorySync,
    "syncPendingAttachedRepositoryCommitsAfterTurn",
  ).mockResolvedValue({ results: [] });
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Teleport source",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    setActiveRuntime(listener);
    const options = {
      connectionId: "source",
      wsUrl: "ws://test",
      deviceId: "source",
      connectionName: "Source",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const oldSocket = new Socket();
    openListenerConnection({
      runtime: listener,
      connectionId: "source",
      writer: oldSocket as never,
      options,
    });
    oldSocket.readyState = WebSocket.CLOSED;
    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: {
        type: "teleport_request",
        request_id: "unsent",
        teleport_id: "unsent",
        runtime: { agent_id: agent.id, conversation_id: conversation.id },
        target: {
          connection_id: "target",
          device_id: "target",
          connection_name: "Target",
        },
      },
    });
    closeListenerConnection(listener, "source");
    const socket = new Socket();
    openListenerConnection({
      runtime: listener,
      connectionId: "source",
      writer: socket as never,
      options,
    }).initialized = true;
    subscribeListenerConnection(listener, "source", {
      agent_id: agent.id,
      conversation_id: conversation.id,
    });
    const accepted = mock(() => {});
    dispatchInboundMessageWhenReady({
      listener,
      runtime,
      incoming: {
        type: "message",
        agentId: agent.id,
        conversationId: conversation.id,
        messages: [{ role: "user", content: "hello after reconnect" }],
      },
      socket: socket as never,
      options,
      processIncomingMessage: handleIncomingMessage,
      processQueuedTurn: async () => {
        throw new Error("idle input should start directly");
      },
      trackListenerError: (_type, error) => {
        throw error;
      },
      onInputAccepted: accepted,
    });
    await runtime.messageQueue;
    expect(accepted).toHaveBeenCalledWith({
      accepted: true,
      disposition: "started",
    });
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "turn_finished",
        stop_reason: "end_turn",
      }),
    );
    const reloaded = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    const messages = await reloaded.listConversationMessages(conversation.id, {
      agent_id: agent.id,
    });
    expect(messages.getPaginatedItems()).toContainEqual(
      expect.objectContaining({
        message_type: "assistant_message",
        content: [{ type: "text", text: "pong" }],
      }),
    );
    expect(runtime.turnLifecycle.kind).toBe("idle");
  } finally {
    sync.mockRestore();
    __testSetBackend(null);
    await rm(storageDir, { recursive: true, force: true });
  }
}, 30_000);

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
