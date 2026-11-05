import { afterEach, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { createBuffers } from "@/cli/helpers/accumulator";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { routeInputFrame } from "./input-frame-router";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import { handleTeleportRequest } from "./teleport";
import { handleApprovalStop } from "./turn-approval";
import { createTurnCorrelation } from "./turn-correlation";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createTurnFinalizer } from "./turn-finalizer";
import type { ProcessQueuedTurn, StartListenerOptions } from "./types";

afterEach(() => {
  setActiveRuntime(null);
  createInterruptedTurnStore().remove("agent-1", "conv-1");
});

// Exercise admission and the real queue pump, rather than setting pump flags
// on a manually constructed active turn. Only turn setup, tool execution and
// the model send are replaced; both production handoff boundaries run below.
test.each(["tool return", "end turn"] as const)(
  "an input started by the queue hands off at its next %s boundary",
  async (boundary) => {
    const listener = createRuntime();
    listener.connectionId = "conn-source";
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const frames: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (data: string) => frames.push(JSON.parse(data)),
    } as unknown as WebSocket;
    const options: StartListenerOptions = {
      connectionId: "source",
      wsUrl: "ws://test",
      deviceId: "source-device",
      connectionName: "Source",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    openListenerConnection({
      runtime: listener,
      connectionId: "source",
      writer: socket,
      options,
    });
    markListenerConnectionInitialized(listener, "source");
    subscribeListenerConnection(listener, "source", {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    setActiveRuntime(listener);
    const sendContinuation = mock(async () => ({
      kind: "terminal",
      drainResult: { stopReason: "end_turn", apiDurationMs: 0 },
    }));
    let turns = 0;
    const processQueuedTurn: ProcessQueuedTurn = async (incoming, batch) => {
      turns++;
      const lease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      expect(runtime.queuePumpActive).toBe(true);
      expect(runtime.queueRuntime.length).toBe(0);
      expect(runtime.queuedMessagesByItemId.size).toBe(0);
      const requestTeleport = () =>
        handleTeleportRequest({
          listener,
          connectionId: "source",
          command: {
            type: "teleport_request",
            request_id: "teleport-1",
            teleport_id: "teleport-1",
            runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
            target: {
              connection_id: "target",
              device_id: "target-device",
              connection_name: "Target",
            },
          },
        });
      const ownership = createTurnDurabilityOwnership();
      ownership.recordInput(incoming);
      const finalizer = createTurnFinalizer({
        runtime,
        turnLease: lease,
        socket,
        ownership,
        turnCorrelation: createTurnCorrelation(
          runtime,
          incoming,
          batch.batchId,
        ),
        buffers: createBuffers("agent-1"),
        agentId: "agent-1",
        conversationId: "conv-1",
      });
      if (boundary === "tool return") {
        const approval = {
          toolCallId: "bash-1",
          toolName: "Bash",
          toolArgs: "{}",
        };
        const result = await handleApprovalStop({
          approvals: [approval],
          runtime,
          socket,
          agentId: "agent-1",
          conversationId: "conv-1",
          turnWorkingDirectory: process.cwd(),
          turnPermissionModeState: { mode: "unrestricted" },
          dequeuedBatchId: batch.batchId,
          msgRunIds: [],
          turnInput: { messages: incoming.messages },
          pendingNormalizationInterruptedToolCallIds: [],
          turnToolContextId: null,
          turnLease: lease,
          buildSendOptions: () => ({}) as never,
          dependencies: {
            classifyApprovals: async () => ({
              autoAllowed: [{ approval, parsedArgs: {}, context: null }],
              autoDenied: [],
              needsUserInput: [],
            }),
            executeApprovalBatch: async () => {
              requestTeleport();
              return [
                {
                  type: "tool",
                  tool_call_id: "bash-1",
                  status: "success",
                  tool_return: "completed Bash result",
                },
              ];
            },
            ensureSecretsHydrated: async () => {},
            sendApprovalContinuation: sendContinuation,
          } as never,
        });
        expect(result.kind).toBe("teleport");
        if (result.kind !== "teleport") throw new Error("Missed tool boundary");
        expect(result.pendingTeleport.continuation?.approvals).toEqual([
          expect.objectContaining({
            tool_call_id: "bash-1",
            tool_return: "completed Bash result",
          }),
        ]);
      } else {
        // A pending teleport must also survive an end_turn response without
        // declaring the Slack delivery terminal on the source.
        requestTeleport();
      }
      expect(
        finalizer.finishTurn({
          stopReason: "end_turn",
          agentId: "agent-1",
          conversationId: "conv-1",
        }).finished,
      ).toBe(true);
    };
    await routeInputFrame({
      runtime: listener,
      socket,
      connectionId: "source",
      opts: options,
      parsed: {
        type: "input",
        request_id: "slack-input",
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "reply in Slack" }],
        },
      },
      processQueuedTurn,
      getOrCreateScopedRuntime,
      handleApprovalResponseInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_socket, payload) => {
        frames.push(payload as unknown as Record<string, unknown>);
        return true;
      },
      runDetachedListenerTask: (_name, task) => void task(),
      trackListenerError: (_type, error) => {
        throw error;
      },
      processIncomingMessage: async () => {
        throw new Error("Content bypassed the queue");
      },
    });
    await runtime.messageQueue;
    expect(turns).toBe(1);
    expect(sendContinuation).not.toHaveBeenCalled();
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        accepted: true,
        disposition: "queued",
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        active_turn: true,
        success: true,
      }),
    );
    expect(frames.some((frame) => frame.type === "turn_finished")).toBe(false);
  },
);
