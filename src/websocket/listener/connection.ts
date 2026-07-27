import type WebSocket from "ws";
import type { DequeuedBatch } from "@/queue/queue-runtime";
import {
  handleAbortMessageInput,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
} from "@/websocket/listener/control-inputs";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { releaseExternalToolConnection } from "@/websocket/listener/external-tools";
import { createFileCommandSession } from "@/websocket/listener/file-commands";
import {
  getParsedRuntimeScope,
  replaySyncStateForRuntime,
  runDetachedListenerTask,
  safeSocketSend,
  stampInboundUserMessageOtids,
  trackListenerError,
  wireChannelIngress,
} from "@/websocket/listener/lifecycle";
import { createListenerMessageHandler } from "@/websocket/listener/message-router";
import { handleIncomingMessage } from "@/websocket/listener/turn";
import type {
  IncomingMessage,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";

export interface ListenerConnectionScopeHooks {
  claim(scope: {
    agent_id: string;
    conversation_id: string;
  }): "claimed" | "already_owned";
  release(scope: { agent_id: string; conversation_id: string }): void;
  owns(scope: { agent_id: string; conversation_id: string }): boolean;
}

export interface AttachListenerConnectionOptions {
  startupReady?: Promise<void>;
  scopeHooks: ListenerConnectionScopeHooks;
  onClosed: () => void;
}

/**
 * Attach one app-server client to a process-owned listener runtime.
 *
 * Request handlers and turn delivery capture this socket, but disconnect only
 * releases this connection's scopes. Process services and other clients stay
 * alive until the app-server itself shuts down.
 */
export function attachListenerConnection(
  runtime: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
  options: AttachListenerConnectionOptions,
): void {
  const fileCommandSession = createFileCommandSession({
    socket,
    safeSocketSend,
    runDetachedListenerTask,
  });

  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ): Promise<void> => {
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      socket,
      scopedRuntime,
      opts.onStatusChange,
      opts.connectionId,
      dequeuedBatch.batchId,
    );
  };

  const handleMessage = createListenerMessageHandler({
    runtime,
    socket,
    opts,
    processQueuedTurn,
    fileCommandSession,
    getParsedRuntimeScope,
    replaySyncStateForRuntime,
    getOrCreateScopedRuntime,
    handleApprovalResponseInput,
    handleChangeDeviceStateInput,
    handleAbortMessageInput,
    stampInboundUserMessageOtids,
    safeSocketSend,
    runDetachedListenerTask,
    trackListenerError,
    wireChannelIngress,
    claimRuntimeScope: options.scopeHooks.claim,
    releaseRuntimeScope: options.scopeHooks.release,
    ownsRuntimeScope: options.scopeHooks.owns,
  });

  socket.on("message", (data: WebSocket.RawData) => {
    void (async () => {
      await options.startupReady;
      await handleMessage(data);
    })().catch((error) => {
      trackListenerError(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      opts.onError(error instanceof Error ? error : new Error(String(error)));
    });
  });

  let closed = false;
  const closeConnection = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    fileCommandSession.dispose();
    releaseExternalToolConnection(runtime, socket);
    options.onClosed();
    opts.onDisconnected();
  };

  socket.on("close", closeConnection);
  socket.on("error", (error: Error) => {
    trackListenerError("listener_websocket_error", error, "listener_socket");
    opts.onError(error);
  });
}
