import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIError } from "@letta-ai/letta-client/error";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import type {
  LoopErrorMessage,
  StreamDeltaMessage,
  WsProtocolMessage,
} from "@/types/protocol_v2";
import {
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { createRuntime } from "./lifecycle";
import { enqueueOutboundFrame, OUTBOUND_QUEUE_LIMITS } from "./outbound-wire";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";

test.each([false, true])(
  "pre-run rejection carries accepted IDs before idle (backpressure=%s)",
  async (backpressure) => {
    const storageDir = await mkdtemp(join(tmpdir(), "listener-pre-run-"));
    const sync = spyOn(
      repositorySync,
      "syncPendingAttachedRepositoryCommitsAfterTurn",
    ).mockResolvedValue({ results: [] });
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    const request = spyOn(
      backend,
      "createConversationMessageStream",
    ).mockRejectedValue(
      new APIError(
        403,
        { detail: "Message author is not authorized" },
        undefined,
        new Headers(),
      ),
    );
    const frames: WsProtocolMessage[] = [];
    const socket = {
      kind: "local" as const,
      bufferedAmount: backpressure
        ? OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES
        : 0,
      isOpen: () => true,
      send: (payload: string) => {
        frames.push(JSON.parse(payload));
      },
    };
    try {
      __testSetBackend(backend);
      await settingsManager.initialize();
      const agent = await backend.createAgent({
        name: "Pre-run rejection",
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
        connectionId: "pre-run-test",
        wsUrl: "ws://test",
        deviceId: "test",
        connectionName: "Test",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      };
      openListenerConnection({
        runtime: listener,
        connectionId: options.connectionId,
        writer: socket,
        options,
      }).initialized = true;
      subscribeListenerConnection(listener, options.connectionId, {
        agent_id: agent.id,
        conversation_id: conversation.id,
      });
      let accepted = false;
      dispatchInboundMessageWhenReady({
        listener,
        runtime,
        socket,
        options,
        incoming: {
          type: "message",
          agentId: agent.id,
          conversationId: conversation.id,
          messages: [
            {
              role: "user",
              content: "pre-run failure",
              client_message_id: "cm-pre-run",
            },
          ],
        },
        processIncomingMessage: handleIncomingMessage,
        processQueuedTurn: async () => {
          throw new Error("should start directly");
        },
        trackListenerError: (_type, error) => {
          throw error;
        },
        onInputAccepted: (result) => {
          accepted = result.accepted;
        },
      });
      await runtime.messageQueue;
      socket.bufferedAmount = 0;
      enqueueOutboundFrame(socket, {
        typeLabel: "flush",
        frameClass: "critical",
        build: () => null,
      });
      expect(accepted).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      const failures = frames.filter(
        (frame): frame is StreamDeltaMessage & { delta: LoopErrorMessage } =>
          frame.type === "stream_delta" &&
          frame.delta.message_type === "loop_error",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.delta).toMatchObject({
        is_terminal: true,
        client_message_ids: ["cm-pre-run"],
      });
      expect(failures[0]?.delta.message).toContain(
        "Message author is not authorized",
      );
      expect(failures[0]?.delta.run_id).toBeUndefined();
      const idleIndex = frames.findIndex(
        (frame) =>
          frame.type === "update_loop_status" &&
          frame.loop_status.status === "WAITING_ON_INPUT",
      );
      const failure = failures[0];
      if (!failure) throw new Error("Expected one emitted loop error");
      expect(idleIndex).toBeGreaterThan(frames.indexOf(failure));
      expect(runtime.turnLifecycle.kind).toBe("idle");
      if (process.env.LETTA_TEST_PRE_RUN_FRAMES) {
        await writeFile(
          `${process.env.LETTA_TEST_PRE_RUN_FRAMES}-${backpressure}.json`,
          JSON.stringify(frames, null, 2),
        );
      }
    } finally {
      request.mockRestore();
      sync.mockRestore();
      __testSetBackend(null);
      setActiveRuntime(null);
      await rm(storageDir, { recursive: true, force: true });
    }
  },
  30_000,
);
