import type WebSocket from "ws";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getLocalChannelTeleportError } from "@/channels/teleport-guard";
import type {
  TeleportContinuation,
  TeleportFailedCommand,
  TeleportProbeCommand,
  TeleportReadyMessage,
  TeleportRequestCommand,
} from "@/types/protocol_v2";
import { toListenerConnection } from "./connection";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import {
  emitProtocolV2Message,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getConversationRuntime } from "./runtime";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerConnectionId,
  ListenerRuntime,
  PendingTeleport,
  StartListenerOptions,
} from "./types";

type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

const TELEPORT_RECOVERY_TTL_MS = 5 * 60_000;
/**
 * How long a destination waits for the `teleport_continue` announced by its
 * `runtime_start` before sync recovery may again finish stale approvals on its
 * own. The cloud holds its per-conversation teleport lock for 60 seconds.
 */
const INBOUND_TELEPORT_CONTINUE_TTL_MS = 60_000;

/**
 * Record that the cloud is about to send `teleport_continue` for this scope.
 * The source's yielded turn left pending approvals on the backend; the
 * continuation carries their results, so sync recovery must not deny them as
 * stale and start a competing turn (the destination would then reject the
 * continuation with "already processing").
 */
export function expectInboundTeleport(
  runtime: ConversationRuntime,
  teleportId: string,
): void {
  runtime.expectedTeleportId = teleportId;
  runtime.expectedTeleportExpiresAt =
    Date.now() + INBOUND_TELEPORT_CONTINUE_TTL_MS;
}

export function isInboundTeleportExpected(
  runtime: ConversationRuntime,
): boolean {
  if (runtime.expectedTeleportId === null) return false;
  if (
    runtime.expectedTeleportExpiresAt !== null &&
    runtime.expectedTeleportExpiresAt <= Date.now()
  ) {
    clearExpectedInboundTeleport(runtime);
    return false;
  }
  return true;
}

export function clearExpectedInboundTeleport(
  runtime: ConversationRuntime,
): void {
  runtime.expectedTeleportId = null;
  runtime.expectedTeleportExpiresAt = null;
}

export function buildTeleportContinuationMessages(params: {
  teleportId: string;
  approvals?: TeleportContinuation["approvals"];
}): IncomingMessage["messages"] {
  const messages: IncomingMessage["messages"] = [];
  if (params.approvals?.length) {
    messages.push({
      type: "approval",
      approvals: params.approvals,
      otid: params.teleportId,
    });
  }
  messages.push({
    role: "user",
    content:
      "<system-reminder>Teleportation to this environment is complete. Continue the existing task from this environment now.</system-reminder>",
    otid: `${params.teleportId}:continue`,
  });
  return messages;
}

function escapeSystemReminderText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildTeleportFailureMessages(params: {
  teleportId: string;
  error: string;
  approvals?: NonNullable<TeleportContinuation["approvals"]>;
}): IncomingMessage["messages"] {
  const messages: IncomingMessage["messages"] = [];
  if (params.approvals && params.approvals.length > 0) {
    messages.push({
      type: "approval",
      approvals: params.approvals,
      otid: params.teleportId,
    });
  }
  messages.push({
    role: "user",
    content: `<system-reminder>Teleportation failed.\n\nError: ${escapeSystemReminderText(params.error)}\n\nContinue the existing task from this environment now.</system-reminder>`,
    otid: `${params.teleportId}:failed`,
  });
  return messages;
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
      supported: resolveBackendMode() === "api",
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
  const channelError = getLocalChannelTeleportError(pending);
  if (channelError) {
    pending.readyAt = Date.now();
    pending.error = channelError;
    pendingTeleports.set(pending.teleportId, pending);
    sendTeleportReady(listener, pending, {
      success: false,
      error: channelError,
    });
    retainTeleportForRecovery(listener, pending);
    return;
  }
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
    const connection = listener.connections.get(pending.connectionId);
    if (!connection || !isListenerTransportOpen(connection.writer)) {
      pendingTeleports.delete(pending.teleportId);
      return;
    }
    if (emitClaimedTeleportReady(listener, pending)) {
      pending.readyAt = Date.now();
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
  if (!connection || !isListenerTransportOpen(connection.writer)) {
    // No readiness was sent and the source still owns its turn and results.
    // Drop only the handoff request so later input is not blocked forever.
    params.listener.pendingTeleports?.delete(pending.teleportId);
    return null;
  }
  pending.readyAt = Date.now();
  pending.activeTurn = params.activeTurn;
  pending.continuation = params.continuation;
  return pending;
}

export function emitClaimedTeleportReady(
  listener: ListenerRuntime,
  pending: PendingTeleport,
): boolean {
  if (listener.connectionId?.startsWith("conn-"))
    suspendRecordedTeleport(pending, true);
  const sent = sendTeleportReady(listener, pending, { success: true });
  if (sent) {
    retainTeleportForRecovery(listener, pending);
  } else if (listener.connectionId?.startsWith("conn-")) {
    suspendRecordedTeleport(pending, false);
  }
  return sent;
}

function suspendRecordedTeleport(
  pending: PendingTeleport,
  suspended: boolean,
): void {
  const store = createInterruptedTurnStore();
  const record = store.read(pending.agentId, pending.conversationId);
  if (record)
    store.write({
      ...record,
      teleportId: suspended ? pending.teleportId : undefined,
    });
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

function takeFailedTeleport(params: {
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

export function handleTeleportFailure(params: {
  listener: ListenerRuntime;
  command: TeleportFailedCommand;
  socket: ListenerTransport;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  getOrCreateScopedRuntime: (
    listener: ListenerRuntime,
    agentId?: string | null,
    conversationId?: string | null,
  ) => ConversationRuntime;
  runDetachedListenerTask: (
    commandName: string,
    task: () => Promise<void>,
  ) => void;
  processIncomingMessage: (
    msg: IncomingMessage,
    socket: ListenerTransport,
    runtime: ConversationRuntime,
    onStatusChange?: StartListenerOptions["onStatusChange"],
    connectionId?: string,
  ) => Promise<void>;
}): void {
  const pending = takeFailedTeleport({
    listener: params.listener,
    teleportId: params.command.teleport_id,
    agentId: params.command.runtime.agent_id,
    conversationId: params.command.runtime.conversation_id,
  });
  // Rejected requests never yielded, so their source turn needs no recovery.
  if (!pending || pending.error) return;

  const runtime = params.getOrCreateScopedRuntime(
    params.listener,
    pending.agentId,
    pending.conversationId,
  );
  emitLoopErrorNotice(params.socket, runtime, {
    message: `Teleport failed: ${params.command.error}`,
    stopReason: "error",
    isTerminal: false,
    agentId: pending.agentId,
    conversationId: pending.conversationId,
  });
  params.runDetachedListenerTask("teleport_failed", async () => {
    await params.processIncomingMessage(
      {
        type: "message",
        connectionId: pending.connectionId,
        agentId: pending.agentId,
        conversationId: pending.conversationId,
        messages: buildTeleportFailureMessages({
          teleportId: params.command.teleport_id,
          error: params.command.error,
          approvals: pending.continuation?.approvals,
        }),
      },
      params.socket,
      runtime,
      params.onStatusChange,
      pending.connectionId,
    );
  });
}
