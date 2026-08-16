import type WebSocket from "ws";
import type {
  TeleportContinuation,
  TeleportProbeCommand,
  TeleportReadyMessage,
  TeleportRequestCommand,
} from "@/types/protocol_v2";
import { toListenerConnection } from "./connection";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import {
  emitProtocolV2Message,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import { getConversationRuntime } from "./runtime";
import { isListenerTransportOpen } from "./transport";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type {
  ConversationRuntime,
  ListenerConnectionId,
  ListenerRuntime,
  PendingTeleport,
} from "./types";

type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

const TELEPORT_RECOVERY_TTL_MS = 5 * 60_000;

function getPendingTeleports(
  runtime: ListenerRuntime,
): Map<string, PendingTeleport> {
  runtime.pendingTeleports ??= new Map();
  return runtime.pendingTeleports;
}

function findPendingTeleportForRuntime(
  runtime: ListenerRuntime,
  agentId: string,
  conversationId: string,
): PendingTeleport | null {
  for (const pending of getPendingTeleports(runtime).values()) {
    if (
      pending.agentId === agentId &&
      pending.conversationId === conversationId &&
      pending.readyAt === undefined
    ) {
      return pending;
    }
  }
  return null;
}

export function isRuntimeWaitingForTeleport(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
): boolean {
  if (!agentId) return false;
  for (const pending of runtime.pendingTeleports?.values() ?? []) {
    if (
      pending.agentId === agentId &&
      pending.conversationId === conversationId &&
      pending.readyAt !== undefined
    ) {
      return true;
    }
  }
  return false;
}

export function clearPriorReadyTeleports(params: {
  listener: ListenerRuntime;
  agentId: string;
  conversationId: string;
  currentTeleportId: string;
}): void {
  for (const [teleportId, pending] of params.listener.pendingTeleports ?? []) {
    if (
      teleportId !== params.currentTeleportId &&
      pending.agentId === params.agentId &&
      pending.conversationId === params.conversationId &&
      pending.readyAt !== undefined
    ) {
      params.listener.pendingTeleports?.delete(teleportId);
    }
  }
}

function sendTeleportReady(
  runtime: ListenerRuntime,
  pending: PendingTeleport,
  input: { success: boolean; error?: string },
): boolean {
  const connection = runtime.connections.get(pending.connectionId);
  if (!connection || !isListenerTransportOpen(connection.writer)) return false;

  const mode = getOrCreateConversationPermissionModeStateRef(
    runtime,
    pending.agentId,
    pending.conversationId,
  ).mode;
  const message: TeleportReadyMessage = {
    type: "teleport_ready",
    teleport_id: pending.teleportId,
    runtime: {
      agent_id: pending.agentId,
      conversation_id: pending.conversationId,
    },
    success: input.success,
    mode,
    ...(pending.continuation ? { continuation: pending.continuation } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  emitProtocolV2Message(
    connection.writer,
    runtime,
    message,
    message.runtime,
    toListenerConnection(pending.connectionId),
  );
  return true;
}

function retainTeleportForRecovery(
  runtime: ListenerRuntime,
  pending: PendingTeleport,
): void {
  const timeout = setTimeout(() => {
    const current = runtime.pendingTeleports?.get(pending.teleportId);
    if (current === pending) {
      runtime.pendingTeleports?.delete(pending.teleportId);
    }
  }, TELEPORT_RECOVERY_TTL_MS);
  timeout.unref?.();
}

export function handleTeleportProbe(
  command: TeleportProbeCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): void {
  safeSocketSend(
    socket,
    {
      type: "teleport_probe_response",
      request_id: command.request_id,
      runtime: command.runtime,
      supported: true,
    },
    "teleport_probe_response",
    "teleport_probe",
  );
}

export function handleTeleportRequest(params: {
  listener: ListenerRuntime;
  command: TeleportRequestCommand;
  connectionId: ListenerConnectionId;
}): void {
  const { listener, command, connectionId } = params;
  const pendingTeleports = getPendingTeleports(listener);
  const existing = pendingTeleports.get(command.teleport_id);
  if (existing) {
    if (existing.readyAt !== undefined) {
      sendTeleportReady(listener, existing, { success: true });
    }
    return;
  }

  const pending: PendingTeleport = {
    teleportId: command.teleport_id,
    connectionId,
    agentId: command.runtime.agent_id,
    conversationId: command.runtime.conversation_id,
    requestedAt: Date.now(),
  };
  const conflicting = findPendingTeleportForRuntime(
    listener,
    pending.agentId,
    pending.conversationId,
  );
  if (conflicting) {
    pendingTeleports.set(pending.teleportId, pending);
    pending.readyAt = Date.now();
    sendTeleportReady(listener, pending, {
      success: false,
      error: "Conversation already has a teleport pending",
    });
    retainTeleportForRecovery(listener, pending);
    return;
  }

  pendingTeleports.set(pending.teleportId, pending);
  const conversationRuntime = getConversationRuntime(
    listener,
    pending.agentId,
    pending.conversationId,
  );
  if (!conversationRuntime?.isProcessing) {
    if (sendTeleportReady(listener, pending, { success: true })) {
      pending.readyAt = Date.now();
      retainTeleportForRecovery(listener, pending);
    }
  }
}

export function claimPendingTeleportAtBoundary(params: {
  listener: ListenerRuntime;
  agentId: string;
  conversationId: string;
  continuation?: TeleportContinuation;
}): PendingTeleport | null {
  const pending = findPendingTeleportForRuntime(
    params.listener,
    params.agentId,
    params.conversationId,
  );
  if (!pending) return null;
  const connection = params.listener.connections.get(pending.connectionId);
  if (!connection || !isListenerTransportOpen(connection.writer)) return null;
  pending.readyAt = Date.now();
  pending.continuation = params.continuation;
  return pending;
}

export function emitClaimedTeleportReady(
  listener: ListenerRuntime,
  pending: PendingTeleport,
): boolean {
  const sent = sendTeleportReady(listener, pending, { success: true });
  if (sent) {
    retainTeleportForRecovery(listener, pending);
  }
  return sent;
}

export function finishTeleport(
  runtime: ConversationRuntime,
  lease: TurnLease,
  pending: PendingTeleport,
): TurnFinishTransition {
  const transition = runtime.turnLifecycle.finish(lease, "cancelled");
  if (!transition.finished) return transition;
  emitRuntimeStateUpdates(runtime, {
    agent_id: pending.agentId,
    conversation_id: pending.conversationId,
  });
  emitClaimedTeleportReady(runtime.listener, pending);
  return transition;
}

export function finishPendingTeleport(runtime: ConversationRuntime): void {
  if (runtime.lastStopReason !== "end_turn" || !runtime.agentId) return;
  const pending = claimPendingTeleportAtBoundary({
    listener: runtime.listener,
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
  });
  if (pending) emitClaimedTeleportReady(runtime.listener, pending);
}

export function takeFailedTeleport(params: {
  listener: ListenerRuntime;
  teleportId: string;
  agentId: string;
  conversationId: string;
}): PendingTeleport | null {
  const pending = params.listener.pendingTeleports?.get(params.teleportId);
  if (
    !pending ||
    pending.agentId !== params.agentId ||
    pending.conversationId !== params.conversationId
  ) {
    return null;
  }
  params.listener.pendingTeleports?.delete(params.teleportId);
  return pending;
}
