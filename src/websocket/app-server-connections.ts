import WebSocket from "ws";
import { rejectPendingApprovalResolvers } from "@/websocket/listener/approval";
import { getWorkingDirectoryScopeKey } from "@/websocket/listener/cwd";
import { enqueueOutboundFrame } from "@/websocket/listener/outbound-wire";
import {
  clearConversationRuntimeState,
  getConversationRuntimeKey,
  nextEventSeq,
} from "@/websocket/listener/runtime";
import type { LocalTransport } from "@/websocket/listener/transport";
import type {
  ConversationRuntime,
  ListenerRuntime,
} from "@/websocket/listener/types";

type RuntimeScope = {
  agent_id: string;
  conversation_id: string;
};

export interface AppServerConnection {
  id: string;
  socket: WebSocket;
  scopes: Set<string>;
}

const STATUS_MESSAGE_TYPES = new Set([
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
]);

function scopeKey(scope: RuntimeScope): string {
  return getConversationRuntimeKey(scope.agent_id, scope.conversation_id);
}

function getMessageScope(
  message: Record<string, unknown>,
): RuntimeScope | null {
  const runtime = message.runtime;
  if (runtime && typeof runtime === "object") {
    const candidate = runtime as Record<string, unknown>;
    if (
      typeof candidate.agent_id === "string" &&
      typeof candidate.conversation_id === "string"
    ) {
      return {
        agent_id: candidate.agent_id,
        conversation_id: candidate.conversation_id,
      };
    }
  }
  if (
    typeof message.agent_id === "string" &&
    typeof message.conversation_id === "string"
  ) {
    return {
      agent_id: message.agent_id,
      conversation_id: message.conversation_id,
    };
  }
  return null;
}

function cleanupConversationRuntime(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
): void {
  rejectPendingApprovalResolvers(runtime, "App-server connection disconnected");
  clearConversationRuntimeState(runtime);
  runtime.queuedMessagesByItemId.clear();
  runtime.queueRuntime.clear("shutdown");
  listener.conversationRuntimes.delete(runtime.key);
  listener.skillSourcesByConversation.delete(runtime.key);
  listener.reminderStateByConversation.delete(runtime.key);
  listener.contextTrackerByConversation.delete(runtime.key);
  listener.systemPromptRecompileByConversation.delete(runtime.key);
  listener.queuedSystemPromptRecompileByConversation.delete(runtime.key);
  for (const [
    requestId,
    runtimeKey,
  ] of listener.approvalRuntimeKeyByRequestId) {
    if (runtimeKey === runtime.key) {
      listener.approvalRuntimeKeyByRequestId.delete(requestId);
    }
  }
  const watcherKey = getWorkingDirectoryScopeKey(
    runtime.agentId,
    runtime.conversationId,
  );
  const watcher = listener.worktreeWatcherByConversation.get(watcherKey);
  watcher?.abort.abort();
  listener.worktreeWatcherByConversation.delete(watcherKey);
}

/**
 * Process transport for app-server-owned work (cron, channels, subagents and
 * task notifications). Frames are routed by runtime scope to exactly one
 * owning connection and then pass through the normal per-socket backpressure
 * queue.
 */
export class AppServerConnectionRouter implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;

  private readonly connections = new Map<string, AppServerConnection>();
  private readonly ownerByScope = new Map<string, AppServerConnection>();
  private closed = false;

  constructor(private readonly runtime: ListenerRuntime) {}

  isOpen(): boolean {
    return !this.closed;
  }

  add(socket: WebSocket): AppServerConnection {
    const connection: AppServerConnection = {
      id: `app-server-${crypto.randomUUID()}`,
      socket,
      scopes: new Set(),
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  claim(
    connection: AppServerConnection,
    scope: RuntimeScope,
  ): "claimed" | "already_owned" {
    const key = scopeKey(scope);
    const existing = this.ownerByScope.get(key);
    if (existing && existing !== connection) {
      throw new Error(
        `Runtime ${scope.agent_id}/${scope.conversation_id} is already owned by another app-server connection`,
      );
    }
    if (existing === connection) {
      return "already_owned";
    }
    this.ownerByScope.set(key, connection);
    connection.scopes.add(key);
    return "claimed";
  }

  owns(connection: AppServerConnection, scope: RuntimeScope): boolean {
    return this.ownerByScope.get(scopeKey(scope)) === connection;
  }

  release(connection: AppServerConnection, scope: RuntimeScope): void {
    const key = scopeKey(scope);
    if (this.ownerByScope.get(key) !== connection) {
      return;
    }
    this.ownerByScope.delete(key);
    connection.scopes.delete(key);
    const conversationRuntime = this.runtime.conversationRuntimes.get(key);
    if (conversationRuntime) {
      cleanupConversationRuntime(this.runtime, conversationRuntime);
    }
  }

  remove(connection: AppServerConnection): void {
    if (this.connections.get(connection.id) !== connection) {
      return;
    }
    this.connections.delete(connection.id);
    for (const key of [...connection.scopes]) {
      if (this.ownerByScope.get(key) === connection) {
        this.ownerByScope.delete(key);
      }
      connection.scopes.delete(key);
      const conversationRuntime = this.runtime.conversationRuntimes.get(key);
      if (conversationRuntime) {
        cleanupConversationRuntime(this.runtime, conversationRuntime);
      }
    }
  }

  send(data: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const scope = getMessageScope(message);
    if (!scope) {
      return;
    }
    const connection = this.ownerByScope.get(scopeKey(scope));
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const type =
      typeof message.type === "string" ? message.type : "unknown_message";
    const frameClass = STATUS_MESSAGE_TYPES.has(type) ? "status" : "critical";
    enqueueOutboundFrame(connection.socket, {
      typeLabel: type,
      frameClass,
      ...(frameClass === "status"
        ? { coalesceKey: `${type}:${scope.agent_id}:${scope.conversation_id}` }
        : {}),
      build: () => {
        let outbound = message;
        if (typeof message.event_seq === "number") {
          const eventSeq = nextEventSeq(this.runtime, connection.socket);
          if (eventSeq === null) {
            return null;
          }
          outbound = {
            ...message,
            event_seq: eventSeq,
            idempotency_key: `${type}:${eventSeq}:${crypto.randomUUID()}`,
          };
        }
        return {
          payload: JSON.stringify(outbound),
          perfKey: `app-server:${type}`,
        };
      },
    });
  }

  close(): void {
    this.closed = true;
    for (const connection of [...this.connections.values()]) {
      this.remove(connection);
      if (
        connection.socket.readyState === WebSocket.OPEN ||
        connection.socket.readyState === WebSocket.CONNECTING
      ) {
        connection.socket.close(1001, "app-server shutting down");
      }
    }
  }

  get size(): number {
    return this.connections.size;
  }
}
