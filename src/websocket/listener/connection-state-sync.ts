import type { RuntimeScope } from "@/types/protocol_v2";
import { replayPendingApprovalRequestsToConnection } from "./approval";
import {
  findListenerConnectionByTransport,
  markListenerConnectionInitialized,
  toListenerConnection,
} from "./connection";
import {
  emitDeviceStatusUpdate,
  emitLoopStatusUpdate,
  emitStateSync,
  refreshDeviceGitContext,
} from "./protocol-outbound";
import { getActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type {
  ConversationRuntime,
  ListenerConnectionId,
  ListenerConnectionState,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

export async function emitInitialConnectionState(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  connectionId: ListenerConnectionId,
  options: { emitInitialState?: boolean } = {},
): Promise<void> {
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
    await refreshDeviceGitContext(conversationRuntime, scope);
    emitDeviceStatusUpdate(transport, conversationRuntime, scope, routing);
    emitLoopStatusUpdate(transport, conversationRuntime, scope, routing);
  }
}

export async function completeInitialConnectionStartup(
  listener: ListenerRuntime,
  connection: ListenerConnectionState,
  transport: ListenerTransport,
  options: Pick<StartListenerOptions, "connectionId" | "onConnected">,
  startupOptions: {
    emitInitialState?: boolean;
    updateReconnectState?: boolean;
  },
): Promise<boolean> {
  const isCurrent = (): boolean =>
    listener === getActiveRuntime() &&
    !listener.intentionallyClosed &&
    listener.connections.get(options.connectionId) === connection;

  await options.onConnected(options.connectionId);
  if (!isCurrent()) return false;
  await emitInitialConnectionState(listener, transport, options.connectionId, {
    emitInitialState: startupOptions.emitInitialState,
  });
  if (!isCurrent()) return false;
  for (const runtime of listener.conversationRuntimes.values()) {
    replayPendingApprovalRequestsToConnection(runtime, options.connectionId);
  }
  if (!isCurrent()) return false;
  if (startupOptions.updateReconnectState) {
    listener.hasSuccessfulConnection = true;
    listener.everConnected = true;
  }
  markListenerConnectionInitialized(listener, options.connectionId, connection);
  return true;
}

export async function replaySubscribedConnectionState(
  listener: ListenerRuntime,
  transport: ListenerTransport,
  runtime: ConversationRuntime,
  scope: RuntimeScope<string | null>,
  options: {
    forceDeviceStatus?: boolean;
    refreshGitContext?: typeof refreshDeviceGitContext;
  } = {},
): Promise<void> {
  await (options.refreshGitContext ?? refreshDeviceGitContext)(listener, scope);
  const connection = findListenerConnectionByTransport(listener, transport);
  if (connection) {
    replayPendingApprovalRequestsToConnection(runtime, connection.id);
  }
  emitStateSync(transport, listener, scope, {
    forceDeviceStatus: options.forceDeviceStatus,
    ...(connection ? { routing: toListenerConnection(connection.id) } : {}),
  });
}
