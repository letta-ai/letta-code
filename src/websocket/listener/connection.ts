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
  ListenerMessageRouting,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

export const TO_SUBSCRIBERS = {
  type: "ToSubscribers",
} as const satisfies ListenerMessageRouting;

export const BROADCAST = {
  type: "Broadcast",
} as const satisfies ListenerMessageRouting;

export function toListenerConnection(
  connectionId: ListenerConnectionId,
): ListenerMessageRouting {
  return { type: "ToConnection", connectionId };
}

type ListenerConnectionResumeState = {
  ordinal: number;
  subscriptions: Set<string>;
  eventSeqCounter: number;
};

const resumeStateByRuntime = new WeakMap<
  ListenerRuntime,
  Map<ListenerConnectionId, ListenerConnectionResumeState>
>();

function getResumeStates(
  runtime: ListenerRuntime,
): Map<ListenerConnectionId, ListenerConnectionResumeState> {
  let states = resumeStateByRuntime.get(runtime);
  if (!states) {
    states = new Map();
    resumeStateByRuntime.set(runtime, states);
  }
  return states;
}

function socketForTransport(transport: ListenerTransport): WebSocket | null {
  return "kind" in transport ? null : transport;
}

function refreshLegacySingleConnection(runtime: ListenerRuntime): void {
  const live = [...runtime.connections.values()].filter((connection) =>
    isListenerTransportOpen(connection.writer),
  );
  const only = live.length === 1 ? live[0] : null;
  // Keep the process-scoped transport stable across relay socket replacement.
  // Turn continuations may capture this handle before a transient disconnect.
  runtime.transport = runtime.processTransport ?? only?.writer ?? null;
  runtime.streamTransport = only?.streamWriter ?? null;
  runtime.socket = only ? socketForTransport(only.writer) : null;
  runtime.streamSocket = only?.streamWriter
    ? socketForTransport(only.streamWriter)
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
  const existing = params.runtime.connections.get(params.connectionId);
  if (existing) {
    throw new Error(`Listener connection already open: ${params.connectionId}`);
  }

  const resumeStates = getResumeStates(params.runtime);
  const resumed = resumeStates.get(params.connectionId);
  resumeStates.delete(params.connectionId);
  const connection: ListenerConnectionState = {
    id: params.connectionId,
    ordinal: resumed?.ordinal ?? params.runtime.nextConnectionOrdinal,
    writer: params.writer,
    streamWriter: params.streamWriter ?? null,
    cancellation: params.cancellation ?? new AbortController(),
    initialized: false,
    subscriptions: resumed?.subscriptions ?? new Set(),
    eventSeqCounter: resumed?.eventSeqCounter ?? 0,
    options: params.options,
  };
  if (!resumed) {
    params.runtime.nextConnectionOrdinal += 1;
  }
  params.runtime.connections.set(connection.id, connection);
  for (const runtimeKey of connection.subscriptions) {
    let connectionIds =
      params.runtime.connectionIdsByRuntimeKey.get(runtimeKey);
    if (!connectionIds) {
      connectionIds = new Set();
      params.runtime.connectionIdsByRuntimeKey.set(runtimeKey, connectionIds);
    }
    connectionIds.add(connection.id);
  }
  refreshLegacySingleConnection(params.runtime);
  return connection;
}

export function markListenerConnectionInitialized(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): void {
  const connection = runtime.connections.get(connectionId);
  if (connection) {
    connection.initialized = true;
  }
}

export function subscribeListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  scope: { agent_id?: string | null; conversation_id?: string | null },
): boolean {
  const connection = runtime.connections.get(connectionId);
  if (!connection || scope.agent_id === undefined) {
    return false;
  }
  const runtimeKey = getConversationRuntimeKey(
    scope.agent_id,
    scope.conversation_id,
  );
  connection.subscriptions.add(runtimeKey);
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
  const connection = runtime.connections.get(connectionId);
  if (!connection?.subscriptions.delete(runtimeKey)) {
    return false;
  }
  const connectionIds = runtime.connectionIdsByRuntimeKey.get(runtimeKey);
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
  if (scope.agent_id === undefined) {
    return [];
  }
  const runtimeKey = getConversationRuntimeKey(
    scope.agent_id,
    scope.conversation_id,
  );
  const connectionIds = runtime.connectionIdsByRuntimeKey.get(runtimeKey);
  if (!connectionIds) {
    return [];
  }
  return [...connectionIds]
    .map((connectionId) => runtime.connections.get(connectionId))
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
  for (const connection of runtime.connections.values()) {
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
  routing: ListenerMessageRouting;
  streamMessage: boolean;
}): ListenerConnectionTarget[] {
  const runtime = params.runtime;
  let connections: Array<ListenerConnectionState | null>;
  switch (params.routing.type) {
    case "ToConnection": {
      const explicitConnection = runtime?.connections.get(
        params.routing.connectionId,
      );
      if (explicitConnection) {
        connections = [explicitConnection];
        break;
      }
      // The outbound Cloud listener predates the connection map. Preserve its
      // single transport while the local app-server always has tracked
      // connections and therefore cannot enter this compatibility branch.
      if (
        (runtime?.connections.size ?? 0) === 0 &&
        params.routing.connectionId === (runtime?.connectionId ?? "legacy")
      ) {
        connections = [null];
        break;
      }
      return [];
    }
    case "ToSubscribers": {
      connections = runtime
        ? getSubscribedListenerConnections(runtime, params.scope)
        : [];
      if (connections.length > 0) {
        break;
      }
      // Letta's outbound Desktop listener is a single pre-subscription
      // transport. This does not apply to app-server connections: once a
      // connection map exists, a scoped message with no subscribers is
      // dropped, matching Codex.
      if ((runtime?.connections.size ?? 0) === 0) {
        connections = [null];
        break;
      }
      return [];
    }
    case "Broadcast": {
      connections = runtime
        ? [...runtime.connections.values()].filter(
            (connection) =>
              connection.initialized &&
              isListenerTransportOpen(connection.writer),
          )
        : [];
      if (connections.length === 0 && (runtime?.connections.size ?? 0) === 0) {
        connections = [null];
      }
      break;
    }
  }

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

export function closeListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): ListenerConnectionState | null {
  getResumeStates(runtime).delete(connectionId);
  const connection = runtime.connections.get(connectionId);
  if (!connection) {
    return null;
  }
  for (const runtimeKey of [...connection.subscriptions]) {
    unsubscribeListenerConnection(runtime, connectionId, runtimeKey);
  }
  runtime.connections.delete(connectionId);
  connection.cancellation.abort();
  refreshLegacySingleConnection(runtime);
  return connection;
}

export function suspendListenerConnection(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): ListenerConnectionState | null {
  const connection = runtime.connections.get(connectionId);
  if (!connection) {
    return null;
  }
  const resumeState: ListenerConnectionResumeState = {
    ordinal: connection.ordinal,
    subscriptions: new Set(connection.subscriptions),
    eventSeqCounter: connection.eventSeqCounter,
  };
  const closed = closeListenerConnection(runtime, connectionId);
  getResumeStates(runtime).set(connectionId, resumeState);
  return closed;
}

class ProcessRuntimeTransport implements RuntimeTransport {
  readonly kind = "runtime" as const;

  constructor(private readonly runtime: ListenerRuntime) {}

  get bufferedAmount(): number {
    let total = 0;
    for (const connection of this.runtime.connections.values()) {
      total += connection.writer.bufferedAmount;
    }
    return total;
  }

  isOpen(): boolean {
    for (const connection of this.runtime.connections.values()) {
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
    throw new Error(
      `Process runtime transport cannot send an implicit message (${data.length} bytes); resolve ToConnection, ToSubscribers, or Broadcast first`,
    );
  }
}

export function getOrCreateProcessTransport(
  runtime: ListenerRuntime,
): ListenerTransport {
  runtime.processTransport ??= new ProcessRuntimeTransport(runtime);
  refreshLegacySingleConnection(runtime);
  return runtime.processTransport;
}
