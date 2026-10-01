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
  ListenerConnectionState,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

export async function emitInitialConnectionState(
  runtime: ListenerRuntime,
  connection: ListenerConnectionState,
  transport: ListenerTransport,
  options: {
    emitInitialState?: boolean;
    refreshGitContext?: typeof refreshDeviceGitContext;
  } = {},
): Promise<boolean> {
  const isCurrent = (): boolean =>
    runtime.connections.get(connection.id) === connection &&
    connection.writer === transport &&
    !connection.cancellation.signal.aborted;

  if (options.emitInitialState === false) return isCurrent();
  if (!isCurrent()) return false;
  const routing = toListenerConnection(connection.id);
  if (runtime.conversationRuntimes.size === 0) {
    emitLoopStatusUpdate(transport, runtime, undefined, routing);
    return isCurrent();
  }

  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    const scope = {
      agent_id: conversationRuntime.agentId,
      conversation_id: conversationRuntime.conversationId,
    };
    await (options.refreshGitContext ?? refreshDeviceGitContext)(
      conversationRuntime,
      scope,
    );
    if (!isCurrent()) return false;
    emitDeviceStatusUpdate(transport, conversationRuntime, scope, routing);
    if (!isCurrent()) return false;
    emitLoopStatusUpdate(transport, conversationRuntime, scope, routing);
    if (!isCurrent()) return false;
  }
  return true;
}

export async function completeInitialConnectionStartup(
  listener: ListenerRuntime,
  connection: ListenerConnectionState,
  transport: ListenerTransport,
  options: Pick<
    StartListenerOptions,
    "connectionId" | "onConnected" | "onConnectionReady"
  >,
  startupOptions: {
    emitInitialState?: boolean;
    updateReconnectState?: boolean;
    refreshGitContext?: typeof refreshDeviceGitContext;
  },
): Promise<boolean> {
  const isCurrent = (): boolean =>
    listener === getActiveRuntime() &&
    !listener.intentionallyClosed &&
    listener.connections.get(options.connectionId) === connection;

  await options.onConnected(options.connectionId);
  if (!isCurrent()) return false;
  if (
    !(await emitInitialConnectionState(listener, connection, transport, {
      emitInitialState: startupOptions.emitInitialState,
      refreshGitContext: startupOptions.refreshGitContext,
    }))
  ) {
    return false;
  }
  if (!isCurrent()) return false;
  for (const runtime of listener.conversationRuntimes.values()) {
    replayPendingApprovalRequestsToConnection(
      runtime,
      options.connectionId,
      connection,
    );
  }
  if (!isCurrent()) return false;
  if (startupOptions.updateReconnectState) {
    listener.hasSuccessfulConnection = true;
    listener.everConnected = true;
  }
  markListenerConnectionInitialized(listener, options.connectionId, connection);
  if (!isCurrent() || !connection.initialized) return false;
  await options.onConnectionReady?.(options.connectionId);
  return isCurrent() && connection.initialized;
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
  const connection = findListenerConnectionByTransport(listener, transport);
  const isCurrent = (): boolean =>
    !connection ||
    (listener.connections.get(connection.id) === connection &&
      (connection.writer === transport ||
        connection.streamWriter === transport) &&
      !connection.cancellation.signal.aborted);
  await (options.refreshGitContext ?? refreshDeviceGitContext)(listener, scope);
  if (!isCurrent()) return;
  if (connection) {
    replayPendingApprovalRequestsToConnection(
      runtime,
      connection.id,
      connection,
    );
    if (!isCurrent()) return;
  }
  emitStateSync(transport, listener, scope, {
    forceDeviceStatus: options.forceDeviceStatus,
    ...(connection ? { routing: toListenerConnection(connection.id) } : {}),
  });
}
