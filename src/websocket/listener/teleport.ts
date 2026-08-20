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
  IncomingMessage,
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

export function buildTeleportContinuationMessages(params: {
  teleportId: string;
  approvals: NonNullable<TeleportContinuation["approvals"]>;
}): IncomingMessage["messages"] {
  return [
    {
      type: "approval",
      approvals: params.approvals,
      otid: params.teleportId,
    },
    {
      role: "system",
      content:
        "<system-reminder>Teleportation to this environment is complete. Continue the existing task from this environment now.</system-reminder>",
      otid: `${params.teleportId}:continue`,
    },
  ];
}

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

export function isRuntimeTeleportPending(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
): boolean {
  if (!agentId) return false;
  return [...(runtime.pendingTeleports?.values() ?? [])].some(
    (pending) =>
      !pending.error &&
      pending.agentId === agentId &&
      pending.conversationId === conversationId,
  );
}

export function clearPriorReadyTeleports(params: {
  listener: ListenerRuntime;
  agentId: string;
  conversationId: string;
  currentTeleportId: string;
}): void {
  const pendingTeleports = params.listener.pendingTeleports;
  if (!pendingTeleports) return;
  for (const [teleportId, pending] of pendingTeleports) {
    if (
      teleportId === params.currentTeleportId ||
      pending.readyAt === undefined
    ) {
      continue;
    }
    if (
      pending.agentId === params.agentId &&
      pending.conversationId === params.conversationId
    ) {
      pendingTeleports.delete(teleportId);
    }
  }
}

function hasAcceptedInputsWaiting(
  runtime: ConversationRuntime,
  includeQueuePump: boolean,
): boolean {
  return (
    runtime.queueRuntime.length > 0 ||
    runtime.pendingTurns > 0 ||
    runtime.queuedMessagesByItemId.size > 0 ||
    (includeQueuePump &&
      (runtime.queuePumpActive || runtime.queuePumpScheduled))
  );
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
    active_turn: pending.activeTurn,
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
      drains_accepted_inputs: true,
      idempotent_continuation: true,
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
      sendTeleportReady(listener, existing, {
        success: existing.error === undefined,
        error: existing.error,
      });
    }
    return;
  }

  const pending: PendingTeleport = {
    teleportId: command.teleport_id,
    connectionId,
    agentId: command.runtime.agent_id,
    conversationId: command.runtime.conversation_id,
    requestedAt: Date.now(),
    drainAcceptedInputs: false,
    activeTurn: false,
  };
  const conflicting = findPendingTeleportForRuntime(
    listener,
    pending.agentId,
    pending.conversationId,
  );
  if (conflicting) {
    pendingTeleports.set(pending.teleportId, pending);
    pending.readyAt = Date.now();
    pending.error = "Conversation already has a teleport pending";
    sendTeleportReady(listener, pending, {
      success: false,
      error: pending.error,
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
  pending.drainAcceptedInputs = conversationRuntime
    ? hasAcceptedInputsWaiting(conversationRuntime, true)
    : false;
  if (!conversationRuntime?.isProcessing && !pending.drainAcceptedInputs) {
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
  activeTurn: boolean;
  continuation?: TeleportContinuation;
}): PendingTeleport | null {
  const pending = findPendingTeleportForRuntime(
    params.listener,
    params.agentId,
    params.conversationId,
  );
  if (!pending) return null;
  if (pending.drainAcceptedInputs) {
    if (params.activeTurn) return null;
    const runtime = getConversationRuntime(
      params.listener,
      params.agentId,
      params.conversationId,
    );
    if (runtime && hasAcceptedInputsWaiting(runtime, false)) return null;
  }
  const connection = params.listener.connections.get(pending.connectionId);
  if (!connection || !isListenerTransportOpen(connection.writer)) return null;
  pending.readyAt = Date.now();
  pending.activeTurn = params.activeTurn;
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
  if (!runtime.agentId) return;
  const pending = findPendingTeleportForRuntime(
    runtime.listener,
    runtime.agentId,
    runtime.conversationId,
  );
  if (
    !pending ||
    (runtime.lastStopReason !== "end_turn" && !pending.drainAcceptedInputs)
  ) {
    return;
  }
  const claimed = claimPendingTeleportAtBoundary({
    listener: runtime.listener,
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
    activeTurn: false,
  });
  if (claimed) emitClaimedTeleportReady(runtime.listener, claimed);
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
