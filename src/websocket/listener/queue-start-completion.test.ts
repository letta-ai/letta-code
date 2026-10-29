import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import type { WsProtocolMessage } from "@/types/protocol_v2";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { createConnectionTurnProcessor } from "./connection-lifecycle";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { routeInputFrame } from "./input-frame-router";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";
import type { StartListenerOptions } from "./types";

test("queued input cannot report completion before its first model request", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "queue-start-completion-"));
  const backend = new LocalBackend({
    storageDir,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  const sync = spyOn(
    repositorySync,
    "syncPendingAttachedRepositoryCommitsAfterTurn",
  ).mockResolvedValue({ results: [] });
  let releaseRequest!: () => void;
  const requestBlocked = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let requestStarted!: () => void;
  const requestEntered = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const createStream = backend.createConversationMessageStream.bind(backend);
  const request = spyOn(
    backend,
    "createConversationMessageStream",
  ).mockImplementation(async (...args) => {
    requestStarted();
    await requestBlocked;
    return createStream(...args);
  });
  const frames: WsProtocolMessage[] = [];
  let echoed = false;
  let prematureCompletion = false;
  let requestFinished = false;
  // Remote listeners have a subscribed WebSocket; no local transport or HTTP
  // processOwnedTurn exemption participates in this turn.
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(payload: string) {
      const frame = JSON.parse(payload) as WsProtocolMessage;
      frames.push(frame);
      if (
        frame.type === "stream_delta" &&
        frame.delta.message_type === "user_message"
      ) {
        echoed = true;
      }
      // A user echo is delivery evidence. An idle frame after that echo tells
      // a remote consumer that the accepted turn has finished, even if there
      // has never been a model run to correlate with it.
      if (
        echoed &&
        frame.type === "update_loop_status" &&
        frame.loop_status.status === "WAITING_ON_INPUT" &&
        !requestFinished
      ) {
        prematureCompletion = true;
      }
    },
  } as unknown as WebSocket;
  let processing: Promise<void> = Promise.resolve();
  try {
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Queue start",
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
    const options: StartListenerOptions = {
      connectionId: "queue-start-test",
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
    });
    markListenerConnectionInitialized(listener, options.connectionId);
    subscribeListenerConnection(listener, options.connectionId, {
      agent_id: agent.id,
      conversation_id: conversation.id,
    });
    await routeInputFrame({
      runtime: listener,
      socket,
      connectionId: options.connectionId,
      opts: options,
      parsed: {
        type: "input",
        request_id: "queue-start-input",
        runtime: { agent_id: agent.id, conversation_id: conversation.id },
        payload: {
          kind: "create_message",
          messages: [
            {
              role: "user",
              content: "hello",
              client_message_id: "cm-queue-start",
            },
          ],
        },
      },
      processQueuedTurn: createConnectionTurnProcessor(listener),
      getOrCreateScopedRuntime,
      handleApprovalResponseInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_socket, payload) => {
        socket.send(JSON.stringify(payload));
        return true;
      },
      runDetachedListenerTask: (_name, task) => {
        void task();
      },
      trackListenerError: (_type, error) => {
        throw error;
      },
      processIncomingMessage: handleIncomingMessage,
    });
    processing = runtime.messageQueue;
    await requestEntered;
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "input_accepted",
        accepted: true,
        disposition: "queued",
      }),
    );
    expect(echoed).toBe(true);
    expect(prematureCompletion).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(runtime.turnLifecycle.kind).toBe("active");
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "update_loop_status",
        loop_status: expect.objectContaining({ status: "SENDING_API_REQUEST" }),
      }),
    );
    requestFinished = true;
    releaseRequest();
    await processing;
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "update_loop_status",
        loop_status: expect.objectContaining({ status: "WAITING_ON_INPUT" }),
      }),
    );
  } finally {
    releaseRequest();
    await processing;
    request.mockRestore();
    sync.mockRestore();
    setActiveRuntime(null);
    __testSetBackend(null);
    await rm(storageDir, { recursive: true, force: true });
  }
});
