import WebSocket from "ws";
import { killListenerConnectionTerminals } from "@/websocket/terminal-handler";
import { rejectPendingApprovalResolversForConnection } from "./approval";
import {
  closeListenerConnection,
  getOrCreateProcessTransport,
  getSubscribedListenerConnections,
} from "./connection";
import {
  getOrCreateScopedRuntime,
  scheduleDurableQueueRestore,
} from "./conversation-runtime";
import { rejectPendingExternalToolCallsForConnection } from "./external-tools";
import {
  ordinaryInputIdentity,
  requeueStartedInputDispositions,
} from "./input-disposition";
import { revokeRecoveryClaims } from "./recovery-ownership";
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
      const discardedClientMessageIds =
        scopedRuntime.dequeuedClientMessageIdsByBatchId.get(
          dequeuedBatch.batchId,
        ) ?? [];
      const discardedIdentities =
        scopedRuntime.dequeuedInputIdentitiesByBatchId.get(
          dequeuedBatch.batchId,
        ) ??
        discardedClientMessageIds.flatMap((clientMessageId) => {
          const identity = ordinaryInputIdentity(clientMessageId);
          return identity ? [identity] : [];
        });
      requeueStartedInputDispositions(scopedRuntime, discardedIdentities);
      scopedRuntime.dequeuedClientMessageIdsByBatchId.delete(
        dequeuedBatch.batchId,
      );
      scopedRuntime.dequeuedInputIdentitiesByBatchId.delete(
        dequeuedBatch.batchId,
      );
      scheduleDurableQueueRestore(runtime, false);
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
  revokeRecoveryClaims(runtime, connectionId);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    if (conversationRuntime.activeConnectionId === connectionId) {
      const closingConnection = runtime.connections.get(connectionId);
      const hasEligibleFailover = getSubscribedListenerConnections(runtime, {
        agent_id: conversationRuntime.agentId,
        conversation_id: conversationRuntime.conversationId,
      }).some((connection) => connection.id !== connectionId);
      if (
        hasEligibleFailover &&
        closingConnection?.options.connectionIdCanResume === false
      ) {
        conversationRuntime.activeConnectionId =
          getSubscribedListenerConnections(runtime, {
            agent_id: conversationRuntime.agentId,
            conversation_id: conversationRuntime.conversationId,
          }).find((connection) => connection.id !== connectionId)?.id ?? null;
      } else if (!hasEligibleFailover) {
        const awaitsRotatingTerminalHandoff =
          closingConnection?.options.connectionIdCanResume === false &&
          conversationRuntime.pendingTerminalDeliveryCount > 0;
        if (awaitsRotatingTerminalHandoff) {
          conversationRuntime.activeConnectionId = null;
        } else {
          conversationRuntime.turnLifecycle.requestCancellation({
            cause: "transport",
          });
        }
      }
    }
    for (const [
      itemId,
      queuedMessage,
    ] of conversationRuntime.queuedMessagesByItemId) {
      if (queuedMessage.connectionId === connectionId) {
        // The accepted payload is process-owned once queued. Detach only the
        // vanished delivery route; the queue pump will wait for a subscribed
        // replacement and the durable ledger remains replayable meanwhile.
        conversationRuntime.queuedMessagesByItemId.set(itemId, {
          ...queuedMessage,
          connectionId: undefined,
        });
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
      if (
        socket.readyState !== WebSocket.CLOSED &&
        typeof socket.on === "function" &&
        typeof socket.once === "function" &&
        typeof socket.removeListener === "function"
      ) {
        // ws can emit an error after close() while a handshake is still pending.
        const ignoreError = () => {};
        socket.on("error", ignoreError);
        socket.once("close", () => {
          socket.removeListener("error", ignoreError);
        });
      }
    }
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  }
}
