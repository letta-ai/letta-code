import WebSocket from "ws";
import { killListenerConnectionTerminals } from "@/websocket/terminal-handler";
import { rejectPendingApprovalResolversForConnection } from "./approval";
import {
  closeListenerConnection,
  getOrCreateProcessTransport,
  getSubscribedListenerConnections,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { rejectPendingExternalToolCallsForConnection } from "./external-tools";
import { evictConversationRuntimeIfIdle } from "./runtime";
import { getListenerTransportKind, type ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import type {
  ListenerConnectionId,
  ListenerRuntime,
  ProcessQueuedTurn,
} from "./types";

export function createConnectionTurnProcessor(
  runtime: ListenerRuntime,
): ProcessQueuedTurn {
  return async (queuedTurn, dequeuedBatch) => {
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    if (!queuedTurn.connectionId) {
      await handleIncomingMessage(
        queuedTurn,
        getOrCreateProcessTransport(runtime),
        scopedRuntime,
        undefined,
        undefined,
        dequeuedBatch.batchId,
      );
      return;
    }
    const connection = runtime.connections.get(queuedTurn.connectionId);
    if (!connection || connection.cancellation.signal.aborted) {
      scopedRuntime.dequeuedClientMessageIdsByBatchId.delete(
        dequeuedBatch.batchId,
      );
      return;
    }
    await handleIncomingMessage(
      queuedTurn,
      getOrCreateProcessTransport(runtime),
      scopedRuntime,
      connection.options.onStatusChange,
      connection.id,
      dequeuedBatch.batchId,
    );
  };
}

export function cleanupListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): void {
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    if (conversationRuntime.activeConnectionId === connectionId) {
      const hasEligibleFailover = getSubscribedListenerConnections(runtime, {
        agent_id: conversationRuntime.agentId,
        conversation_id: conversationRuntime.conversationId,
      }).some((connection) => connection.id !== connectionId);
      if (hasEligibleFailover) {
        conversationRuntime.activeConnectionId = null;
      } else {
        conversationRuntime.turnLifecycle.requestCancellation();
      }
    }
    for (const [
      itemId,
      queuedMessage,
    ] of conversationRuntime.queuedMessagesByItemId) {
      if (queuedMessage.connectionId === connectionId) {
        conversationRuntime.queueRuntime.removeItem(itemId);
        conversationRuntime.queuedMessagesByItemId.delete(itemId);
      }
    }
    rejectPendingApprovalResolversForConnection(
      conversationRuntime,
      connectionId,
      "Listener connection closed",
    );
  }
  rejectPendingExternalToolCallsForConnection(
    runtime,
    connectionId,
    "Listener connection closed",
  );
  killListenerConnectionTerminals(connectionId);
  const closedSubscriptionKeys = [
    ...(runtime.connections.get(connectionId)?.subscriptions ?? []),
  ];
  closeListenerConnection(runtime, connectionId);
  for (const runtimeKey of closedSubscriptionKeys) {
    if (!runtime.connectionIdsByRuntimeKey.has(runtimeKey)) {
      const scopedRuntime = runtime.conversationRuntimes.get(runtimeKey);
      if (scopedRuntime) {
        evictConversationRuntimeIfIdle(scopedRuntime);
      }
    }
  }
}

export function closeListenerRuntimeConnections(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  const socketsToClose = new Set<WebSocket>();
  const collectSocket = (transport: ListenerTransport | null | undefined) => {
    if (transport && getListenerTransportKind(transport) === "websocket") {
      socketsToClose.add(transport as WebSocket);
    }
  };
  if (runtime.socket) {
    socketsToClose.add(runtime.socket);
  }
  if (runtime.streamSocket) {
    socketsToClose.add(runtime.streamSocket);
  }
  for (const connection of runtime.connections.values()) {
    collectSocket(connection.writer);
    collectSocket(connection.streamWriter);
  }
  for (const connectionId of [...runtime.connections.keys()]) {
    closeListenerConnection(runtime, connectionId);
  }
  runtime.connectionIdsByRuntimeKey.clear();
  runtime.socket = null;
  runtime.transport = null;
  runtime.streamSocket = null;
  runtime.streamTransport = null;

  for (const socket of socketsToClose) {
    if (suppressCallbacks) {
      socket.removeAllListeners();
    }
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  }
}
