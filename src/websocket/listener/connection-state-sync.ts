import type { RuntimeScope } from "@/types/protocol_v2";
import { replayPendingApprovalRequestsToConnection } from "./approval";
import {
  findListenerConnectionByTransport,
  toListenerConnection,
} from "./connection";
import {
  emitDeviceStatusUpdate,
  emitLoopStatusUpdate,
  emitStateSync,
} from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type {
  ConversationRuntime,
  ListenerConnectionId,
  ListenerRuntime,
} from "./types";

export function emitInitialConnectionState(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  connectionId: ListenerConnectionId,
  options: { emitInitialState?: boolean } = {},
): void {
  if (options.emitInitialState === false) return;
  const routing = toListenerConnection(connectionId);
  if (runtime.conversationRuntimes.size === 0) {
    emitLoopStatusUpdate(transport, runtime, undefined, routing);
    return;
  }

  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    const scope = {
      agent_id: conversationRuntime.agentId,
      conversation_id: conversationRuntime.conversationId,
    };
    emitDeviceStatusUpdate(transport, conversationRuntime, scope, routing);
    emitLoopStatusUpdate(transport, conversationRuntime, scope, routing);
  }
}

export function replaySubscribedConnectionState(
  listener: ListenerRuntime,
  transport: ListenerTransport,
  runtime: ConversationRuntime,
  scope: RuntimeScope,
  forceDeviceStatus?: boolean,
): void {
  const connection = findListenerConnectionByTransport(listener, transport);
  if (connection) {
    replayPendingApprovalRequestsToConnection(runtime, connection.id);
  }
  emitStateSync(transport, listener, scope, {
    forceDeviceStatus,
    ...(connection ? { routing: toListenerConnection(connection.id) } : {}),
  });
}
