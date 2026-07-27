import type WebSocket from "ws";
import { getConversationRuntimeKey, nextEventSeq } from "./runtime";
import {
  isListenerTransportOpen,
  type ListenerTransport,
  type RuntimeTransport,
} from "./transport";
import type {
  ListenerConnectionId,
  ListenerConnectionState,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

function socketForTransport(transport: ListenerTransport): WebSocket | null {
  return "kind" in transport ? null : transport;
}

function refreshPrimaryConnection(runtime: ListenerRuntime): void {
  const next = [...(runtime.connections?.values() ?? [])]
    .filter((connection) => isListenerTransportOpen(connection.writer))
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  runtime.transport = next?.writer ?? runtime.processTransport;
  runtime.streamTransport = next?.streamWriter ?? null;
  runtime.socket = next ? socketForTransport(next.writer) : null;
  runtime.streamSocket = next?.streamWriter
    ? socketForTransport(next.streamWriter)
    : null;
}

export function createConnectionRequestKey(
  connectionId: ListenerConnectionId,
  requestId: string,
): string {
  return JSON.stringify([connectionId, requestId]);
}

export function openListenerConnection(params: {
  runtime: ListenerRuntime;
  connectionId: ListenerConnectionId;
  writer: ListenerTransport;
  streamWriter?: ListenerTransport | null;
  cancellation?: AbortController;
  options: StartListenerOptions;
}): ListenerConnectionState {
  const existing = params.runtime.connections?.get(params.connectionId);
  if (existing) {
    throw new Error(`Listener connection already open: ${params.connectionId}`);
  }

  const connection: ListenerConnectionState = {
    id: params.connectionId,
    ordinal: params.runtime.nextConnectionOrdinal,
    writer: params.writer,
    streamWriter: params.streamWriter ?? null,
    cancellation: params.cancellation ?? new AbortController(),
    initialized: false,
    subscriptions: new Set(),
    eventSeqCounter: 0,
    options: params.options,
  };
  params.runtime.nextConnectionOrdinal ??= 0;
  params.runtime.nextConnectionOrdinal += 1;
  params.runtime.connections ??= new Map();
  params.runtime.connectionIdsByRuntimeKey ??= new Map();
  params.runtime.connections.set(connection.id, connection);
  refreshPrimaryConnection(params.runtime);
  return connection;
}

export function markListenerConnectionInitialized(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): void {
  const connection = runtime.connections?.get(connectionId);
  if (connection) {
    connection.initialized = true;
  }
}

export function subscribeListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  scope: { agent_id?: string | null; conversation_id?: string | null },
): boolean {
  const connection = runtime.connections?.get(connectionId);
  if (!connection || typeof scope.agent_id !== "string") {
    return false;
  }
  const runtimeKey = getConversationRuntimeKey(
    scope.agent_id,
    scope.conversation_id,
  );
  connection.subscriptions.add(runtimeKey);
  runtime.connectionIdsByRuntimeKey ??= new Map();
  let connectionIds = runtime.connectionIdsByRuntimeKey.get(runtimeKey);
  if (!connectionIds) {
    connectionIds = new Set();
    runtime.connectionIdsByRuntimeKey.set(runtimeKey, connectionIds);
  }
  connectionIds.add(connectionId);
  return true;
}

export function unsubscribeListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  runtimeKey: string,
): boolean {
  const connection = runtime.connections?.get(connectionId);
  if (!connection?.subscriptions.delete(runtimeKey)) {
    return false;
  }
  const connectionIds = runtime.connectionIdsByRuntimeKey?.get(runtimeKey);
  connectionIds?.delete(connectionId);
  if (connectionIds?.size === 0) {
    runtime.connectionIdsByRuntimeKey.delete(runtimeKey);
  }
  return true;
}

export function getSubscribedListenerConnections(
  runtime: ListenerRuntime,
  scope: { agent_id?: string | null; conversation_id?: string | null },
): ListenerConnectionState[] {
  if (typeof scope.agent_id !== "string") {
    return [];
  }
  const runtimeKey = getConversationRuntimeKey(
    scope.agent_id,
    scope.conversation_id,
  );
  const connectionIds = runtime.connectionIdsByRuntimeKey?.get(runtimeKey);
  if (!connectionIds) {
    return [];
  }
  return [...connectionIds]
    .map((connectionId) => runtime.connections?.get(connectionId))
    .filter(
      (connection): connection is ListenerConnectionState =>
        connection?.initialized === true &&
        isListenerTransportOpen(connection.writer),
    )
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function findListenerConnectionByTransport(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
): ListenerConnectionState | null {
  for (const connection of runtime.connections?.values() ?? []) {
    if (
      connection.writer === transport ||
      connection.streamWriter === transport
    ) {
      return connection;
    }
  }
  return null;
}

export interface ListenerConnectionTarget {
  connection: ListenerConnectionState | null;
  transport: ListenerTransport;
}

export function nextListenerConnectionEventSeq(
  connection: ListenerConnectionState | null,
  runtime: ListenerRuntime | null,
): number | null {
  if (!connection) {
    return nextEventSeq(runtime);
  }
  connection.eventSeqCounter += 1;
  return connection.eventSeqCounter;
}

export function resolveListenerConnectionTargets(params: {
  runtime: ListenerRuntime | null;
  origin: ListenerTransport;
  scope: { agent_id?: string | null; conversation_id?: string | null };
  connectionId?: ListenerConnectionId;
  subscribers: boolean;
  streamMessage: boolean;
}): ListenerConnectionTarget[] {
  const explicitConnection = params.connectionId
    ? params.runtime?.connections.get(params.connectionId)
    : undefined;
  const subscribedConnections =
    params.runtime && params.subscribers
      ? getSubscribedListenerConnections(params.runtime, params.scope)
      : [];
  const originConnection = params.runtime
    ? findListenerConnectionByTransport(params.runtime, params.origin)
    : null;
  const connections: Array<ListenerConnectionState | null> = explicitConnection
    ? [explicitConnection]
    : subscribedConnections.length > 0
      ? subscribedConnections
      : originConnection
        ? [originConnection]
        : [null];

  return connections.map((connection) => {
    const streamTransport = connection?.streamWriter;
    if (
      params.streamMessage &&
      streamTransport &&
      isListenerTransportOpen(streamTransport)
    ) {
      return { connection, transport: streamTransport };
    }
    const legacyStreamTransport = params.runtime?.streamTransport;
    if (
      !connection &&
      params.streamMessage &&
      legacyStreamTransport &&
      isListenerTransportOpen(legacyStreamTransport)
    ) {
      return { connection, transport: legacyStreamTransport };
    }
    return { connection, transport: connection?.writer ?? params.origin };
  });
}

/**
 * Prefer the connection that initiated the operation. Background/channel
 * operations use the oldest live subscriber, matching Codex's deterministic
 * lowest-ConnectionId controller selection.
 */
export function selectListenerController(
  runtime: ListenerRuntime,
  scope: { agent_id?: string | null; conversation_id?: string | null },
  preferredTransport?: ListenerTransport,
): ListenerConnectionState | null {
  if (preferredTransport) {
    const preferred = findListenerConnectionByTransport(
      runtime,
      preferredTransport,
    );
    if (
      preferred &&
      preferred.initialized &&
      isListenerTransportOpen(preferred.writer)
    ) {
      return preferred;
    }
    if (isListenerTransportOpen(preferredTransport)) {
      return {
        id: runtime.connectionId ?? "legacy",
        ordinal: -1,
        writer: preferredTransport,
        streamWriter: null,
        cancellation: new AbortController(),
        initialized: true,
        subscriptions: new Set(),
        eventSeqCounter: runtime.eventSeqCounter,
        options: {
          connectionId: runtime.connectionId ?? "legacy",
          wsUrl: "legacy://listener",
          deviceId: "legacy",
          connectionName: runtime.connectionName ?? "legacy",
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      };
    }
  }
  return getSubscribedListenerConnections(runtime, scope)[0] ?? null;
}

export function closeListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): ListenerConnectionState | null {
  const connection = runtime.connections?.get(connectionId);
  if (!connection) {
    return null;
  }
  for (const runtimeKey of [...connection.subscriptions]) {
    unsubscribeListenerConnection(runtime, connectionId, runtimeKey);
  }
  runtime.connections?.delete(connectionId);
  connection.cancellation.abort();
  refreshPrimaryConnection(runtime);
  return connection;
}

class ProcessRuntimeTransport implements RuntimeTransport {
  readonly kind = "runtime" as const;

  constructor(private readonly runtime: ListenerRuntime) {}

  get bufferedAmount(): number {
    let total = 0;
    for (const connection of this.runtime.connections?.values() ?? []) {
      total += connection.writer.bufferedAmount;
    }
    return total;
  }

  isOpen(): boolean {
    for (const connection of this.runtime.connections?.values() ?? []) {
      if (
        connection.initialized &&
        isListenerTransportOpen(connection.writer)
      ) {
        return true;
      }
    }
    return false;
  }

  send(data: string): void {
    for (const connection of this.runtime.connections?.values() ?? []) {
      if (
        connection.initialized &&
        isListenerTransportOpen(connection.writer)
      ) {
        connection.writer.send(data);
      }
    }
  }
}

export function getOrCreateProcessTransport(
  runtime: ListenerRuntime,
): ListenerTransport {
  runtime.processTransport ??= new ProcessRuntimeTransport(runtime);
  return runtime.processTransport;
}
