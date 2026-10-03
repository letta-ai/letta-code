import type WebSocket from "ws";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getLocalChannelTeleportError } from "@/channels/teleport-guard";
import { getStoredClientPreferences } from "@/tools/client-preferences";
import type {
  TeleportContinuation,
  TeleportFailedAckMessage,
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
import {
  createTeleportRecoveryStore,
  type TeleportRecoveryStore,
} from "./teleport-recovery-store";
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

type RecoveryMessageProcessor = (
  msg: IncomingMessage,
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  onStatusChange?: StartListenerOptions["onStatusChange"],
  connectionId?: string,
  dequeuedBatchId?: string,
  existingTurnLease?: undefined,
  existingTurnCorrelation?: undefined,
  onInputAccepted?: () => void,
) => Promise<void>;

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
      pending.failureRecovery !== "applied" &&
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
    client_preferences: getStoredClientPreferences(
      pending.agentId,
      pending.conversationId,
    ),
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

function persistTeleportProof(
  pending: PendingTeleport,
  disposition: "yielded" | "rejected",
  store = createTeleportRecoveryStore(),
): void {
  const existing = store.read(pending.teleportId);
  if (
    existing &&
    (existing.agentId !== pending.agentId ||
      existing.conversationId !== pending.conversationId ||
      existing.sourceConnectionId !== pending.connectionId)
  ) {
    throw new Error(
      "Teleport ID is already bound to a different source runtime",
    );
  }
  if (
    existing?.disposition === disposition &&
    existing.error === pending.error &&
    JSON.stringify(existing.continuation) ===
      JSON.stringify(pending.continuation)
  ) {
    return;
  }
  store.write({
    teleportId: pending.teleportId,
    agentId: pending.agentId,
    conversationId: pending.conversationId,
    sourceConnectionId: pending.connectionId,
    disposition,
    recordedAt: existing?.recordedAt ?? Date.now(),
    ...(pending.error ? { error: pending.error } : {}),
    ...(pending.continuation ? { continuation: pending.continuation } : {}),
    ...(existing?.recoveryAcceptedAt
      ? { recoveryAcceptedAt: existing.recoveryAcceptedAt }
      : {}),
  });
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
      acknowledges_failed_teleports: true,
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
    persistTeleportProof(pending, "rejected");
    sendTeleportReady(listener, pending, {
      success: false,
      error: channelError,
    });
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
    persistTeleportProof(pending, "rejected");
    sendTeleportReady(listener, pending, {
      success: false,
      error: pending.error,
    });
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
  // Durable proof must precede readiness: once Cloud observes ready, this source
  // may need to unwind after a process restart.
  persistTeleportProof(pending, "yielded");
  if (listener.connectionId?.startsWith("conn-"))
    suspendRecordedTeleport(pending, true);
  const sent = sendTeleportReady(listener, pending, { success: true });
  if (!sent && listener.connectionId?.startsWith("conn-")) {
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
  if (!runtime.turnLifecycle.isCurrent(lease)) {
    return runtime.turnLifecycle.finish(lease, "cancelled");
  }
  // Persistence and lifecycle finalization are synchronous, so no replacement
  // lease can interleave after this current-owner check and before finish().
  persistTeleportProof(pending, "yielded");
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

function findFailedTeleport(params: {
  listener: ListenerRuntime;
  teleportId: string;
  agentId: string;
  conversationId: string;
  connectionId: ListenerConnectionId;
  store: TeleportRecoveryStore;
}): PendingTeleport | null {
  const stored = params.store.read(params.teleportId);
  if (stored) {
    if (
      stored.agentId !== params.agentId ||
      stored.conversationId !== params.conversationId ||
      stored.sourceConnectionId !== params.connectionId
    ) {
      return null;
    }
    const pending = params.listener.pendingTeleports?.get(params.teleportId);
    if (pending) {
      pending.failureRecovery = stored.recoveryAcceptedAt
        ? "applied"
        : pending.failureRecovery;
      if (stored.disposition === "rejected" && !pending.error) {
        pending.error =
          stored.error ?? "Teleport request was rejected by source";
      }
      return pending;
    }
    return {
      teleportId: stored.teleportId,
      connectionId: stored.sourceConnectionId,
      agentId: stored.agentId,
      conversationId: stored.conversationId,
      requestedAt: stored.recordedAt,
      drainAcceptedInputs: false,
      activeTurn: false,
      readyAt: stored.recordedAt,
      ...(stored.disposition === "rejected"
        ? { error: stored.error ?? "Teleport request was rejected by source" }
        : {}),
      ...(stored.continuation ? { continuation: stored.continuation } : {}),
      ...(stored.recoveryAcceptedAt ? { failureRecovery: "applied" } : {}),
    };
  }

  // Compatibility for an in-memory handoff created by an older listener build.
  const pending = params.listener.pendingTeleports?.get(params.teleportId);
  if (
    !pending ||
    pending.agentId !== params.agentId ||
    pending.conversationId !== params.conversationId ||
    pending.connectionId !== params.connectionId
  ) {
    return null;
  }
  persistTeleportProof(
    pending,
    pending.error ? "rejected" : "yielded",
    params.store,
  );
  return pending;
}

function acknowledgeTeleportFailure(params: {
  listener: ListenerRuntime;
  command: TeleportFailedCommand;
  socket: ListenerTransport;
  connectionId: ListenerConnectionId;
}): void {
  if (params.command.request_id === undefined) return;
  const message: TeleportFailedAckMessage = {
    type: "teleport_failed_ack",
    request_id: params.command.request_id,
    teleport_id: params.command.teleport_id,
    runtime: params.command.runtime,
  };
  emitProtocolV2Message(
    params.socket,
    params.listener,
    message,
    message.runtime,
    toListenerConnection(params.connectionId),
  );
}

export function handleTeleportFailure(params: {
  listener: ListenerRuntime;
  command: TeleportFailedCommand;
  socket: ListenerTransport;
  connectionId: ListenerConnectionId;
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
  processIncomingMessage: RecoveryMessageProcessor;
  recoveryStore?: TeleportRecoveryStore;
}): void {
  const recoveryStore = params.recoveryStore ?? createTeleportRecoveryStore();
  const pending = findFailedTeleport({
    listener: params.listener,
    teleportId: params.command.teleport_id,
    agentId: params.command.runtime.agent_id,
    conversationId: params.command.runtime.conversation_id,
    connectionId: params.connectionId,
    store: recoveryStore,
  });
  if (!pending) return;
  // A source-rejected request never yielded. A matching correlated unwind is an
  // exact no-op, but still settles so older Cloud callers cannot hang.
  if (pending.error) {
    acknowledgeTeleportFailure(params);
    params.listener.pendingTeleports?.delete(pending.teleportId);
    return;
  }
  if (pending.failureRecovery === "applied") {
    acknowledgeTeleportFailure(params);
    params.listener.pendingTeleports?.delete(pending.teleportId);
    return;
  }
  if (pending.failureRecovery === "in_flight") return;
  pending.failureRecovery = "in_flight";

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
    let accepted = false;
    let acceptanceError: unknown;
    try {
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
        undefined,
        undefined,
        undefined,
        () => {
          try {
            const proof = recoveryStore.read(pending.teleportId);
            if (
              !proof ||
              proof.disposition !== "yielded" ||
              proof.agentId !== pending.agentId ||
              proof.conversationId !== pending.conversationId ||
              proof.sourceConnectionId !== pending.connectionId
            ) {
              throw new Error(
                "Teleport recovery proof changed before admission",
              );
            }
            // Core accepted the deterministic OTIDs before this local atomic
            // write. If this write crashes, retrying those OTIDs is idempotent;
            // if it succeeds, all later retries re-ack without replaying.
            recoveryStore.write({ ...proof, recoveryAcceptedAt: Date.now() });
            accepted = true;
            pending.failureRecovery = "applied";
            acknowledgeTeleportFailure(params);
            params.listener.pendingTeleports?.delete(pending.teleportId);
          } catch (error) {
            acceptanceError = error;
            throw error;
          }
        },
      );
      if (!accepted) {
        throw (
          acceptanceError ??
          new Error("Teleport recovery input was not accepted")
        );
      }
    } catch (error) {
      pending.failureRecovery = undefined;
      throw error;
    }
  });
}
