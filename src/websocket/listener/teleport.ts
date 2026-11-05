import type WebSocket from "ws";
import { resolveBackendMode } from "@/backend/backend-mode";
import { getLocalChannelTeleportError } from "@/channels/teleport-guard";
import { getStoredClientPreferences } from "@/tools/client-preferences";
import type {
  TeleportContinuation,
  TeleportFailedCommand,
  TeleportProbeCommand,
  TeleportReadyMessage,
  TeleportRequestCommand,
} from "@/types/protocol_v2";
import { toListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  clearAcceptedFailedTeleportBounded,
  type FailedTeleportCleanupDependencies,
} from "./failed-teleport-cleanup";
import {
  commitInputDisposition,
  reserveInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import { rollbackInputDisposition } from "./input-disposition-rollback";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
} from "./interrupted-turn-record";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import { emitProtocolV2Message } from "./protocol-outbound";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getConversationRuntime } from "./runtime";
import { emitTeleportFailedAck } from "./teleport-failed-ack";
import {
  classifyPersistedTeleportTerminal,
  commitActiveTeleportTerminalTransfer,
  journalTeleportIntent,
  persistSuccessorTeleportReady,
  retainDurableTeleportTerminal,
  retireTeleportTerminalProof,
} from "./teleport-terminal-transfer";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import type { TurnFinishTransition } from "./turn-lifecycle";
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
const INBOUND_TELEPORT_CONTINUE_TTL_MS = 60_000;
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
function pendingTeleportKey(
  agentId: string,
  conversationId: string,
  teleportId: string,
): string {
  return JSON.stringify([agentId, conversationId, teleportId]);
}
function persistedTeleportRecord(
  agentId: string,
  conversationId: string,
  teleportId: string,
): InterruptedTurnRecord | null {
  const record = createInterruptedTurnStore().read(agentId, conversationId);
  return record?.teleport?.teleportId === teleportId ? record : null;
}
function authorizePersistedTeleportReady(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  record: InterruptedTurnRecord,
): boolean {
  const intent = record.teleport;
  if (!intent || !record.revision) return false;
  if (
    !intent.ready &&
    classifyPersistedTeleportTerminal(runtime, record) !== "present"
  ) {
    return false;
  }
  pending.activeTurn = intent.activeTurn;
  pending.continuation = intent.continuation;
  if (intent.ready) {
    retireTeleportTerminalProof(record, intent.committedRevision);
    return true;
  }
  const store = createInterruptedTurnStore();
  const committedRevision = intent.committedRevision ?? intent.intentRevision;
  if (!committedRevision) return false;
  try {
    const readyRecord = store.write(
      {
        ...record,
        teleport: {
          ...intent,
          connectionId: pending.connectionId,
          ready: true,
          committedRevision,
          ...(record.revision !== committedRevision
            ? { preserveSuccessorWork: true }
            : {}),
        },
      },
      record.revision,
    );
    pending.interruptedRevision = readyRecord.revision;
    retireTeleportTerminalProof(readyRecord, committedRevision);
    return true;
  } catch {
    return false;
  }
}
function persistIdleTeleportReady(
  pending: PendingTeleport,
  intentRevision: string,
): boolean {
  const store = createInterruptedTurnStore();
  const record = store.read(pending.agentId, pending.conversationId);
  if (
    record?.revision !== intentRevision ||
    record.teleport?.teleportId !== pending.teleportId
  ) {
    return false;
  }
  try {
    const readyRecord = store.write(
      {
        ...record,
        teleport: {
          ...record.teleport,
          ready: true,
          committedRevision: intentRevision,
        },
      },
      intentRevision,
    );
    pending.interruptedRevision = readyRecord.revision;
    return true;
  } catch {
    return false;
  }
}

function abandonTeleportIntent(
  listener: ListenerRuntime,
  pending: PendingTeleport,
  intentRevision: string | undefined,
): string | undefined {
  listener.pendingTeleports?.delete(
    pendingTeleportKey(
      pending.agentId,
      pending.conversationId,
      pending.teleportId,
    ),
  );
  if (!intentRevision) return undefined;
  const store = createInterruptedTurnStore();
  const record = store.read(pending.agentId, pending.conversationId);
  if (
    record?.revision !== intentRevision ||
    record.teleport?.teleportId !== pending.teleportId
  ) {
    return undefined;
  }
  try {
    return store.write(
      { ...record, teleportId: undefined, teleport: undefined },
      intentRevision,
    ).revision;
  } catch {
    return undefined;
  }
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
  for (const [key, pending] of pendingTeleports) {
    if (
      pending.teleportId === params.currentTeleportId ||
      pending.readyAt === undefined
    ) {
      continue;
    }
    if (
      pending.agentId === params.agentId &&
      pending.conversationId === params.conversationId
    ) {
      pendingTeleports.delete(key);
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

function retainTeleportForRecovery(
  runtime: ListenerRuntime,
  pending: PendingTeleport,
): void {
  const key = pendingTeleportKey(
    pending.agentId,
    pending.conversationId,
    pending.teleportId,
  );
  const timeout = setTimeout(() => {
    const current = runtime.pendingTeleports?.get(key);
    if (current === pending) {
      runtime.pendingTeleports?.delete(key);
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
      transfers_terminal_consumers: true,
    },
    "teleport_probe_response",
    "teleport_probe",
  );
}
export function handleTeleportRequest(params: {
  listener: ListenerRuntime;
  command: TeleportRequestCommand;
  connectionId: ListenerConnectionId;
  journalIntent?: typeof journalTeleportIntent;
  persistIdleReady?: typeof persistIdleTeleportReady;
}): void {
  const { listener, command, connectionId } = params;
  const pendingTeleports = getPendingTeleports(listener);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    command.runtime.agent_id,
    command.runtime.conversation_id,
  );
  const key = pendingTeleportKey(
    command.runtime.agent_id,
    command.runtime.conversation_id,
    command.teleport_id,
  );
  const existing = pendingTeleports.get(key);
  if (existing) {
    existing.connectionId = connectionId;
    if (existing.readyAt !== undefined) {
      sendTeleportReady(listener, existing, {
        success: existing.error === undefined,
        error: existing.error,
      });
    } else {
      const record = persistedTeleportRecord(
        command.runtime.agent_id,
        command.runtime.conversation_id,
        command.teleport_id,
      );
      if (
        record &&
        authorizePersistedTeleportReady(scopedRuntime, existing, record)
      ) {
        emitClaimedTeleportReady(listener, existing);
      }
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
  const persistedForScope = listener.connectionId?.startsWith("conn-")
    ? createInterruptedTurnStore().read(pending.agentId, pending.conversationId)
    : null;
  const persisted =
    persistedForScope?.teleport?.teleportId === pending.teleportId
      ? persistedForScope
      : null;
  if (persisted?.teleport) {
    pending.activeTurn = persisted.teleport.activeTurn;
    pending.continuation = persisted.teleport.continuation;
    pendingTeleports.set(key, pending);
    if (authorizePersistedTeleportReady(scopedRuntime, pending, persisted)) {
      emitClaimedTeleportReady(listener, pending);
    }
    return;
  }
  if (persistedForScope?.teleport) {
    pendingTeleports.set(key, pending);
    pending.readyAt = Date.now();
    pending.error = "Conversation already has a teleport pending";
    sendTeleportReady(listener, pending, {
      success: false,
      error: pending.error,
    });
    retainTeleportForRecovery(listener, pending);
    return;
  }
  const channelError = getLocalChannelTeleportError(pending);
  if (channelError) {
    pending.readyAt = Date.now();
    pending.error = channelError;
    pendingTeleports.set(key, pending);
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
    pendingTeleports.set(key, pending);
    pending.readyAt = Date.now();
    pending.error = "Conversation already has a teleport pending";
    sendTeleportReady(listener, pending, {
      success: false,
      error: pending.error,
    });
    retainTeleportForRecovery(listener, pending);
    return;
  }

  pendingTeleports.set(key, pending);
  const conversationRuntime = getOrCreateScopedRuntime(
    listener,
    pending.agentId,
    pending.conversationId,
  );
  pending.drainAcceptedInputs = hasAcceptedInputsWaiting(
    conversationRuntime,
    !conversationRuntime.isProcessing,
  );
  if (!conversationRuntime.isProcessing && !pending.drainAcceptedInputs) {
    const connection = listener.connections.get(pending.connectionId);
    if (!connection || !isListenerTransportOpen(connection.writer)) {
      pendingTeleports.delete(key);
      return;
    }
    if (!listener.connectionId?.startsWith("conn-")) {
      if (emitClaimedTeleportReady(listener, pending))
        pending.readyAt = Date.now();
      return;
    }
    let intentRevision: string | undefined;
    try {
      intentRevision = (params.journalIntent ?? journalTeleportIntent)(
        conversationRuntime,
        pending,
      );
    } catch {
      pendingTeleports.delete(key);
      return;
    }
    if (
      !intentRevision ||
      !(params.persistIdleReady ?? persistIdleTeleportReady)(
        pending,
        intentRevision,
      )
    ) {
      abandonTeleportIntent(listener, pending, intentRevision);
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
  drainedOnly?: boolean;
}): PendingTeleport | null {
  const pending = findPendingTeleportForRuntime(
    params.listener,
    params.agentId,
    params.conversationId,
  );
  if (!pending || (params.drainedOnly && !pending.drainAcceptedInputs))
    return null;
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
    params.listener.pendingTeleports?.delete(
      pendingTeleportKey(
        pending.agentId,
        pending.conversationId,
        pending.teleportId,
      ),
    );
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
  const sent = sendTeleportReady(listener, pending, { success: true });
  if (sent) {
    pending.readyAt = Date.now();
    retainTeleportForRecovery(listener, pending);
    listener.scheduleRecordedRecovery?.();
  }
  return sent;
}

export function finalizeClaimedTeleport<T extends { finished: boolean }>(
  runtime: ListenerRuntime,
  pending: PendingTeleport,
  commitTerminal: () => T,
  canCommit: () => boolean = () => true,
): T {
  const transition = commitTerminal();
  if (
    transition.finished &&
    canCommit() &&
    emitClaimedTeleportReady(runtime, pending)
  ) {
    pending.readyAt = pending.readyAt ?? Date.now();
  }
  return transition;
}

export function finishClaimedTeleport(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  commit: (options: {
    stopReason: import("@/types/protocol_v2").StopReasonType;
    agentId: string;
    conversationId: string;
    persistTerminalWithoutConsumers?: boolean;
    expectedInterruptedRevision?: string;
    teleportHandoff?: boolean;
    onBeforePrepareInputTerminal?: (
      terminal: import("./types").DurablePreparedInputTerminal,
    ) => string | false | undefined;
    validatePreparedInputTerminal?: (
      terminal: import("./types").DurablePreparedInputTerminal,
    ) => boolean;
  }) => TurnFinishTransition,
  options: {
    stopReason?: import("@/types/protocol_v2").StopReasonType;
    canCommit?: () => boolean;
    expectedInterruptedRevision?: string;
    beforeReadyPersist?: () => void;
  } = {},
): TurnFinishTransition {
  let intentRevision: string | undefined;
  if (!pending.activeTurn) {
    try {
      intentRevision = journalTeleportIntent(
        runtime,
        pending,
        options.expectedInterruptedRevision,
      );
    } catch (error) {
      abandonTeleportIntent(runtime.listener, pending, undefined);
      throw error;
    }
  }

  let transition: TurnFinishTransition;
  try {
    if (pending.activeTurn) {
      const result = commitActiveTeleportTerminalTransfer({
        runtime,
        pending,
        commit,
        stopReason: options.stopReason ?? "cancelled",
        expectedInterruptedRevision: options.expectedInterruptedRevision,
        onUnavailable: (revision) =>
          abandonTeleportIntent(runtime.listener, pending, revision),
      });
      if (result.fallback) return result.transition;
      intentRevision = result.revision;
      transition = result.transition;
    } else {
      transition = commit({
        stopReason: options.stopReason ?? "cancelled",
        agentId: pending.agentId,
        conversationId: pending.conversationId,
        persistTerminalWithoutConsumers: intentRevision !== undefined,
        expectedInterruptedRevision: intentRevision,
      });
    }
  } catch (error) {
    if (
      !retainDurableTeleportTerminal(runtime, pending, intentRevision, error)
    ) {
      abandonTeleportIntent(runtime.listener, pending, intentRevision);
    }
    throw error;
  }
  if (!transition.finished) {
    if (!retainDurableTeleportTerminal(runtime, pending, intentRevision))
      abandonTeleportIntent(runtime.listener, pending, intentRevision);
    return transition;
  }

  if (!intentRevision) {
    if (options.canCommit?.() !== false)
      emitClaimedTeleportReady(runtime.listener, pending);
    return transition;
  }
  const store = createInterruptedTurnStore();
  let record: InterruptedTurnRecord | null;
  try {
    record = store.readOrThrow(pending.agentId, pending.conversationId);
  } catch {
    runtime.listener.scheduleRecordedRecovery?.();
    return transition;
  }
  if (!record) {
    pending.readyAt = Date.now();
    pending.error = "Teleport intent disappeared after source terminal commit";
    sendTeleportReady(runtime.listener, pending, {
      success: false,
      error: pending.error,
    });
    retainTeleportForRecovery(runtime.listener, pending);
    return transition;
  }
  if (record.revision !== intentRevision) {
    if (options.canCommit?.() === false) {
      runtime.listener.scheduleRecordedRecovery?.();
      return transition;
    }
    const readyRecord = persistSuccessorTeleportReady(
      runtime,
      pending,
      record,
      intentRevision,
    );
    if (readyRecord) {
      pending.interruptedRevision = readyRecord.revision;
      retireTeleportTerminalProof(readyRecord, intentRevision);
      emitClaimedTeleportReady(runtime.listener, pending);
    }
    return transition;
  }
  if (!record.teleport) return transition;
  const terminalProof = classifyPersistedTeleportTerminal(runtime, record);
  if (options.canCommit?.() === false) {
    if (terminalProof === "absent") {
      abandonTeleportIntent(runtime.listener, pending, intentRevision);
    } else {
      runtime.listener.scheduleRecordedRecovery?.();
    }
    return transition;
  }
  if (terminalProof !== "present") {
    runtime.listener.scheduleRecordedRecovery?.();
    return transition;
  }
  try {
    options.beforeReadyPersist?.();
    const readyRecord = store.write(
      {
        ...record,
        teleport: {
          ...record.teleport,
          ready: true,
          committedRevision: intentRevision,
        },
      },
      intentRevision,
    );
    pending.interruptedRevision = readyRecord.revision;
    retireTeleportTerminalProof(readyRecord, intentRevision);
    emitClaimedTeleportReady(runtime.listener, pending);
  } catch {
    runtime.listener.scheduleRecordedRecovery?.();
  }
  return transition;
}

export function finishDrainedTeleport(
  runtime: ConversationRuntime,
  commit: (options: {
    stopReason: import("@/types/protocol_v2").StopReasonType;
    agentId: string;
    conversationId: string;
    persistTerminalWithoutConsumers?: boolean;
    expectedInterruptedRevision?: string;
  }) => TurnFinishTransition,
  canCommit?: () => boolean,
  expectedInterruptedRevision?: string,
): TurnFinishTransition | null {
  if (!runtime.agentId) return null;
  const pending = claimPendingTeleportAtBoundary({
    listener: runtime.listener,
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
    activeTurn: false,
  });
  if (!pending) {
    return commit({
      stopReason: "end_turn",
      agentId: runtime.agentId,
      conversationId: runtime.conversationId,
    });
  }
  return finishClaimedTeleport(runtime, pending, commit, {
    stopReason: "end_turn",
    canCommit,
    expectedInterruptedRevision,
  });
}

function findFailedTeleport(params: {
  listener: ListenerRuntime;
  teleportId: string;
  agentId: string;
  conversationId: string;
  connectionId: ListenerConnectionId;
}): PendingTeleport | null {
  const key = pendingTeleportKey(
    params.agentId,
    params.conversationId,
    params.teleportId,
  );
  let pending = params.listener.pendingTeleports?.get(key);
  const persisted = createInterruptedTurnStore().read(
    params.agentId,
    params.conversationId,
  );
  const exactPersisted =
    persisted?.teleport?.teleportId === params.teleportId ? persisted : null;
  if (!pending && exactPersisted?.teleport) {
    pending = {
      teleportId: params.teleportId,
      connectionId: params.connectionId,
      agentId: params.agentId,
      conversationId: params.conversationId,
      requestedAt: Date.now(),
      drainAcceptedInputs: false,
      activeTurn: exactPersisted.teleport.activeTurn,
      continuation: exactPersisted.teleport.continuation,
      readyAt: exactPersisted.teleport.ready ? Date.now() : undefined,
      interruptedRevision: exactPersisted.teleport.ready
        ? undefined
        : exactPersisted.revision,
    };
    getPendingTeleports(params.listener).set(key, pending);
  }
  if (!pending) return null;
  pending.connectionId = params.connectionId;
  if (
    !pending.interruptedRevision &&
    exactPersisted?.revision &&
    !exactPersisted.teleport?.ready
  ) {
    pending.interruptedRevision = exactPersisted.revision;
  }
  return pending;
}

export function clearAcceptedFailedTeleport(
  listener: ListenerRuntime,
  pending: PendingTeleport,
  dependencies: FailedTeleportCleanupDependencies = {},
): void {
  clearAcceptedFailedTeleportBounded(listener, pending, dependencies);
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
  processIncomingMessage: (
    msg: IncomingMessage,
    socket: ListenerTransport,
    runtime: ConversationRuntime,
    onStatusChange?: StartListenerOptions["onStatusChange"],
    connectionId?: string,
    dequeuedBatchId?: string,
  ) => Promise<void>;
  failedTeleportCleanup?: FailedTeleportCleanupDependencies;
}): void {
  const runtime = params.getOrCreateScopedRuntime(
    params.listener,
    params.command.runtime.agent_id,
    params.command.runtime.conversation_id,
  );
  const identity = teleportInputIdentity(params.command.teleport_id);
  const pending = findFailedTeleport({
    listener: params.listener,
    teleportId: params.command.teleport_id,
    agentId: params.command.runtime.agent_id,
    conversationId: params.command.runtime.conversation_id,
    connectionId: params.connectionId,
  });
  if (!pending) {
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind === "duplicate") emitTeleportFailedAck(params);
    if (admission.kind === "reserved")
      rollbackInputDisposition(runtime, admission.reservation);
    return;
  }
  if (pending.error) return;
  const incoming: IncomingMessage = {
    type: "message",
    connectionId: params.connectionId,
    agentId: pending.agentId,
    conversationId: pending.conversationId,
    messages: buildTeleportFailureMessages({
      teleportId: params.command.teleport_id,
      error: params.command.error,
      approvals: pending.continuation?.approvals,
    }),
    durableInputIdentities: [identity],
    terminalConsumerIds: pending.continuation?.terminal_consumer_ids,
  };
  const admission = reserveInputDisposition(runtime, identity);
  if (admission.kind === "full") return;
  if (admission.kind === "duplicate") {
    clearAcceptedFailedTeleport(
      params.listener,
      pending,
      params.failedTeleportCleanup,
    );
    params.listener.pendingTeleports?.delete(
      pendingTeleportKey(
        pending.agentId,
        pending.conversationId,
        pending.teleportId,
      ),
    );
    emitTeleportFailedAck(params);
    return;
  }
  const reservation =
    admission.kind === "reserved" ? admission.reservation : undefined;
  if (
    !commitInputDisposition(runtime, reservation, "started", {
      incoming,
    })
  ) {
    rollbackInputDisposition(runtime, reservation);
    return;
  }
  const directBatchId = `batch-teleport-failed-${crypto.randomUUID()}`;
  runtime.dequeuedInputIdentitiesByBatchId.set(directBatchId, [identity]);
  clearAcceptedFailedTeleport(
    params.listener,
    pending,
    params.failedTeleportCleanup,
  );
  params.listener.pendingTeleports?.delete(
    pendingTeleportKey(
      pending.agentId,
      pending.conversationId,
      pending.teleportId,
    ),
  );
  emitTeleportFailedAck(params);
  emitLoopErrorNotice(params.socket, runtime, {
    message: `Teleport failed: ${params.command.error}`,
    stopReason: "error",
    isTerminal: false,
    agentId: pending.agentId,
    conversationId: pending.conversationId,
  });
  params.runDetachedListenerTask("teleport_failed", async () => {
    try {
      await params.processIncomingMessage(
        incoming,
        params.socket,
        runtime,
        params.onStatusChange,
        params.connectionId,
        directBatchId,
      );
    } finally {
      runtime.dequeuedInputIdentitiesByBatchId.delete(directBatchId);
    }
  });
}
