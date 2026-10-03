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
  type TeleportRecoveryRecord,
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

type InterruptedTurnStore = ReturnType<typeof createInterruptedTurnStore>;
const interruptedTurnStoreOverrides = new WeakMap<
  ListenerRuntime,
  InterruptedTurnStore
>();

export function setTeleportInterruptedTurnStoreForTests(
  listener: ListenerRuntime,
  store: InterruptedTurnStore | null,
): void {
  if (store) interruptedTurnStoreOverrides.set(listener, store);
  else interruptedTurnStoreOverrides.delete(listener);
}

function getTeleportInterruptedTurnStore(
  listener: ListenerRuntime,
): InterruptedTurnStore {
  return (
    interruptedTurnStoreOverrides.get(listener) ?? createInterruptedTurnStore()
  );
}

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

function getTeleportRecoveryStore(
  runtime: ListenerRuntime,
): TeleportRecoveryStore {
  return runtime.teleportRecoveryStore ?? createTeleportRecoveryStore();
}

function getTeleportSourceDeviceId(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
): string {
  const deviceId = runtime.connections.get(connectionId)?.options.deviceId;
  if (!deviceId)
    throw new Error("Teleport source device identity is unavailable");
  return deviceId;
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
  readiness: TeleportRecoveryRecord["readiness"],
): boolean {
  const connection = runtime.connections.get(pending.connectionId);
  if (!connection || !isListenerTransportOpen(connection.writer)) return false;

  const message: TeleportReadyMessage = {
    type: "teleport_ready",
    teleport_id: pending.teleportId,
    runtime: {
      agent_id: pending.agentId,
      conversation_id: pending.conversationId,
    },
    ...readiness,
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

function captureTeleportReadiness(
  listener: ListenerRuntime,
  pending: PendingTeleport,
  input: { success: boolean; error?: string },
): TeleportRecoveryRecord["readiness"] {
  return {
    client_preferences: getStoredClientPreferences(
      pending.agentId,
      pending.conversationId,
    ),
    success: input.success,
    active_turn: pending.activeTurn,
    mode: getOrCreateConversationPermissionModeStateRef(
      listener,
      pending.agentId,
      pending.conversationId,
    ).mode,
    ...(pending.continuation ? { continuation: pending.continuation } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function createTeleportRecoveryRecord(params: {
  listener: ListenerRuntime;
  pending: PendingTeleport;
  disposition: "yielded" | "rejected";
  phase: "preparing" | "source_stopped" | "ready";
  readiness: TeleportRecoveryRecord["readiness"];
  previous?: TeleportRecoveryRecord | null;
}): TeleportRecoveryRecord {
  const deviceId = getTeleportSourceDeviceId(
    params.listener,
    params.pending.connectionId,
  );
  return {
    ...(params.previous?.recoveryAcceptedAt
      ? { recoveryAcceptedAt: params.previous.recoveryAcceptedAt }
      : {}),
    teleportId: params.pending.teleportId,
    agentId: params.pending.agentId,
    conversationId: params.pending.conversationId,
    sourceDeviceId: deviceId,
    sourceSessionId: params.listener.sessionId,
    disposition: params.disposition,
    phase: params.phase,
    readiness: params.readiness,
    recordedAt: params.previous?.recordedAt ?? Date.now(),
  };
}

function writeTeleportReadiness(params: {
  listener: ListenerRuntime;
  pending: PendingTeleport;
  disposition: "yielded" | "rejected";
  phase: "preparing" | "source_stopped" | "ready";
  readiness: TeleportRecoveryRecord["readiness"];
  store?: TeleportRecoveryStore;
}): TeleportRecoveryRecord {
  const store = params.store ?? getTeleportRecoveryStore(params.listener);
  const existing = store.read(params.pending.teleportId);
  const deviceId = getTeleportSourceDeviceId(
    params.listener,
    params.pending.connectionId,
  );
  if (
    existing &&
    (existing.agentId !== params.pending.agentId ||
      existing.conversationId !== params.pending.conversationId ||
      existing.sourceDeviceId !== deviceId)
  ) {
    throw new Error(
      "Teleport ID is already bound to a different source device",
    );
  }
  if (
    existing?.phase === "ready" &&
    (existing.disposition !== params.disposition ||
      JSON.stringify(existing.readiness) !== JSON.stringify(params.readiness))
  ) {
    throw new Error("Committed Teleport readiness is immutable");
  }
  const record = createTeleportRecoveryRecord({
    ...params,
    previous: existing,
  });
  store.write(record);
  return record;
}

function pendingFromRecoveryRecord(
  record: TeleportRecoveryRecord,
  connectionId: ListenerConnectionId,
): PendingTeleport {
  return {
    teleportId: record.teleportId,
    connectionId,
    agentId: record.agentId,
    conversationId: record.conversationId,
    requestedAt: record.recordedAt,
    drainAcceptedInputs: false,
    activeTurn: record.readiness.active_turn,
    ...(record.phase === "ready" ? { readyAt: record.recordedAt } : {}),
    ...(record.readiness.error ? { error: record.readiness.error } : {}),
    ...(record.readiness.continuation
      ? { continuation: record.readiness.continuation }
      : {}),
    ...(record.recoveryAcceptedAt ? { failureRecovery: "applied" } : {}),
  };
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

function replayDurableTeleportReadiness(params: {
  listener: ListenerRuntime;
  command: TeleportRequestCommand;
  connectionId: ListenerConnectionId;
}): boolean {
  const { listener, command, connectionId } = params;
  const store = getTeleportRecoveryStore(listener);
  const stored = store.read(command.teleport_id);
  if (!stored) return false;
  if (
    stored.agentId !== command.runtime.agent_id ||
    stored.conversationId !== command.runtime.conversation_id ||
    stored.sourceDeviceId !== getTeleportSourceDeviceId(listener, connectionId)
  ) {
    return true;
  }
  let committed = stored;
  if (stored.phase === "preparing") {
    const interrupted = getTeleportInterruptedTurnStore(listener).read(
      stored.agentId,
      stored.conversationId,
    );
    if (interrupted && interrupted.teleportId !== stored.teleportId) {
      getPendingTeleports(listener).set(
        stored.teleportId,
        pendingFromRecoveryRecord(stored, connectionId),
      );
      return true;
    }
    const sourceRuntime = getConversationRuntime(
      listener,
      stored.agentId,
      stored.conversationId,
    );
    if (
      interrupted &&
      stored.sourceSessionId === listener.sessionId &&
      sourceRuntime &&
      sourceRuntime.turnLifecycle.kind !== "idle"
    ) {
      getPendingTeleports(listener).set(
        stored.teleportId,
        pendingFromRecoveryRecord(stored, connectionId),
      );
      return true;
    }
    if (!interrupted && stored.sourceSessionId === listener.sessionId) {
      return true;
    }
    committed = { ...stored, phase: "ready" };
  } else if (stored.phase === "source_stopped") {
    committed = { ...stored, phase: "ready" };
  }
  // Rewriting before every replay re-establishes the flushed file + directory
  // metadata contract after any prior ambiguous filesystem sync failure.
  store.write(committed);
  const pending = pendingFromRecoveryRecord(committed, connectionId);
  getPendingTeleports(listener).set(pending.teleportId, pending);
  sendTeleportReady(listener, pending, committed.readiness);
  return true;
}

export function handleTeleportRequest(params: {
  listener: ListenerRuntime;
  command: TeleportRequestCommand;
  connectionId: ListenerConnectionId;
  recoveryStore?: TeleportRecoveryStore;
}): void {
  const { listener, command, connectionId } = params;
  if (params.recoveryStore)
    listener.teleportRecoveryStore = params.recoveryStore;
  if (replayDurableTeleportReadiness(params)) return;
  const pendingTeleports = getPendingTeleports(listener);
  const existing = pendingTeleports.get(command.teleport_id);
  if (existing) {
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
    pending.error = channelError;
    pendingTeleports.set(pending.teleportId, pending);
    const readiness = captureTeleportReadiness(listener, pending, {
      success: false,
      error: channelError,
    });
    const record = writeTeleportReadiness({
      listener,
      pending,
      disposition: "rejected",
      phase: "ready",
      readiness,
    });
    pending.readyAt = record.recordedAt;
    sendTeleportReady(listener, pending, readiness);
    return;
  }
  const conflicting = findPendingTeleportForRuntime(
    listener,
    pending.agentId,
    pending.conversationId,
  );
  if (conflicting) {
    pendingTeleports.set(pending.teleportId, pending);
    pending.error = "Conversation already has a teleport pending";
    const readiness = captureTeleportReadiness(listener, pending, {
      success: false,
      error: pending.error,
    });
    const record = writeTeleportReadiness({
      listener,
      pending,
      disposition: "rejected",
      phase: "ready",
      readiness,
    });
    pending.readyAt = record.recordedAt;
    sendTeleportReady(listener, pending, readiness);
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
    emitClaimedTeleportReady(listener, pending);
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
  pending.activeTurn = params.activeTurn;
  pending.continuation = params.continuation;
  return pending;
}

export function emitClaimedTeleportReady(
  listener: ListenerRuntime,
  pending: PendingTeleport,
): boolean {
  if (pending.activeTurn) {
    throw new Error(
      "Active Teleport readiness must finalize through its turn lease",
    );
  }
  const readiness = captureTeleportReadiness(listener, pending, {
    success: true,
  });
  const record = writeTeleportReadiness({
    listener,
    pending,
    disposition: "yielded",
    phase: "ready",
    readiness,
  });
  pending.readyAt = record.recordedAt;
  return sendTeleportReady(listener, pending, readiness);
}

function suspendRecordedTeleport(
  listener: ListenerRuntime,
  pending: PendingTeleport,
  suspended: boolean,
): boolean {
  const store = getTeleportInterruptedTurnStore(listener);
  const record = store.read(pending.agentId, pending.conversationId);
  if (!record) return false;
  store.writeDurable({
    ...record,
    teleportId: suspended ? pending.teleportId : undefined,
  });
  return true;
}

export function finishTeleport(
  runtime: ConversationRuntime,
  lease: TurnLease,
  pending: PendingTeleport,
): TurnFinishTransition {
  if (!runtime.turnLifecycle.isCurrent(lease)) {
    return runtime.turnLifecycle.finish(lease, "cancelled");
  }
  const listener = runtime.listener;
  const store = getTeleportRecoveryStore(listener);
  const readiness = captureTeleportReadiness(listener, pending, {
    success: true,
  });
  const preparing = writeTeleportReadiness({
    listener,
    pending,
    disposition: "yielded",
    phase: "preparing",
    readiness,
    store,
  });
  const suspended = suspendRecordedTeleport(listener, pending, true);
  const transition = runtime.turnLifecycle.finish(lease, "cancelled");
  if (!transition.finished) {
    if (suspended) suspendRecordedTeleport(listener, pending, false);
    store.remove(pending.teleportId);
    return transition;
  }
  const sourceStopped = {
    ...preparing,
    phase: "source_stopped" as const,
  };
  store.write(sourceStopped);
  const committed = { ...sourceStopped, phase: "ready" as const };
  store.write(committed);
  pending.readyAt = committed.recordedAt;
  emitRuntimeStateUpdates(runtime, {
    agent_id: pending.agentId,
    conversation_id: pending.conversationId,
  });
  sendTeleportReady(listener, pending, committed.readiness);
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
      stored.phase !== "ready" ||
      stored.agentId !== params.agentId ||
      stored.conversationId !== params.conversationId ||
      stored.sourceDeviceId !==
        getTeleportSourceDeviceId(params.listener, params.connectionId)
    ) {
      return null;
    }
    const pending = params.listener.pendingTeleports?.get(params.teleportId);
    if (pending) {
      pending.connectionId = params.connectionId;
      pending.failureRecovery = stored.recoveryAcceptedAt
        ? "applied"
        : pending.failureRecovery;
      if (stored.disposition === "rejected" && !pending.error) {
        pending.error =
          stored.readiness.error ?? "Teleport request was rejected by source";
      }
      return pending;
    }
    return pendingFromRecoveryRecord(stored, params.connectionId);
  }

  // Never upgrade volatile readiness into hard-stop authority. Legacy source
  // handoffs remain compatible but non-authoritative until retried and durably
  // committed by this listener build.
  return null;
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
  const recoveryStore =
    params.recoveryStore ?? getTeleportRecoveryStore(params.listener);
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
              proof.phase !== "ready" ||
              proof.disposition !== "yielded" ||
              proof.agentId !== pending.agentId ||
              proof.conversationId !== pending.conversationId ||
              proof.sourceDeviceId !==
                getTeleportSourceDeviceId(params.listener, pending.connectionId)
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
      if (
        !(
          error &&
          typeof error === "object" &&
          "admittedInputCleanupFailed" in error &&
          error.admittedInputCleanupFailed === true
        )
      ) {
        pending.failureRecovery = undefined;
      }
      throw error;
    }
  });
}
