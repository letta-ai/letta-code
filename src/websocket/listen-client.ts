/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import { existsSync } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import {
  type ApprovalDecision,
  type ApprovalResult,
  executeApprovalBatch,
} from "../agent/approval-execution";
import { fetchRunErrorDetail } from "../agent/approval-recovery";
import { normalizeApprovalResultsForPersistence } from "../agent/approval-result-normalization";
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { getStreamToolContextId, sendMessageStream } from "../agent/message";
import {
  extractConflictDetail,
  getPreStreamErrorAction,
  getRetryDelayMs,
  isApprovalPendingError,
  isEmptyResponseRetryable,
  isInvalidToolCallIdsError,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  shouldAttemptApprovalRecovery,
  shouldRetryRunMetadataError,
} from "../agent/turn-recovery-policy";
import { createBuffers } from "../cli/helpers/accumulator";
import { classifyApprovals } from "../cli/helpers/approvalClassification";
import { getRetryStatusMessage } from "../cli/helpers/errorFormatter";
import { resizeImageIfNeeded } from "../cli/helpers/imageResize";
import { generatePlanFilePath } from "../cli/helpers/planName";
import type { ApprovalRequest } from "../cli/helpers/stream";
import {
  discoverFallbackRunIdWithTimeout,
  drainStreamWithResume,
} from "../cli/helpers/stream";
import { INTERRUPTED_BY_USER } from "../constants";
import { computeDiffPreviews } from "../helpers/diffPreview";
import { permissionMode } from "../permissions/mode";
import {
  type DequeuedBatch,
  type QueueBlockedReason,
  type QueueItem,
  QueueRuntime,
} from "../queue/queueRuntime";
import { mergeQueuedTurnInput } from "../queue/turnQueueRuntime";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "../reminders/engine";
import { buildListenReminderContext } from "../reminders/listenContext";
import { getPlanModeReminder } from "../reminders/planModeReminder";
import {
  createSharedReminderState,
  type SharedReminderState,
} from "../reminders/state";
import { settingsManager } from "../settings-manager";
import { isInteractiveApprovalTool } from "../tools/interactivePolicy";
import { getToolNames, loadTools } from "../tools/manager";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ApprovalResponseDecision,
  ChangeDeviceStateCommand,
  ClientToolEndMessage,
  ClientToolStartMessage,
  ControlRequest,
  DeviceStatus,
  DeviceStatusUpdateMessage,
  InputCommand,
  LoopState,
  LoopStatus,
  LoopStatusUpdateMessage,
  PendingControlRequest,
  QueueMessage,
  QueueUpdateMessage,
  RetryMessage,
  RuntimeScope,
  StatusMessage,
  StopReasonType,
  StreamDelta,
  StreamDeltaMessage,
  SyncCommand,
  WsProtocolCommand,
  WsProtocolMessage,
} from "../types/protocol_v2";
import { isDebugEnabled } from "../utils/debug";
import { getListenerBlockedReason } from "./helpers/listenerQueueAdapter";
import { killAllTerminals } from "./terminalHandler";

interface StartListenerOptions {
  connectionId: string;
  wsUrl: string;
  deviceId: string;
  connectionName: string;
  onConnected: (connectionId: string) => void;
  onDisconnected: () => void;
  onNeedsReregister?: () => void;
  onError: (error: Error) => void;
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void;
  onRetrying?: (
    attempt: number,
    maxAttempts: number,
    nextRetryIn: number,
    connectionId: string,
  ) => void;
  /** Debug hook: called for every WS frame sent or received. */
  onWsEvent?: (
    direction: "send" | "recv",
    label: "client" | "protocol" | "control" | "lifecycle",
    event: unknown,
  ) => void;
}

interface IncomingMessage {
  type: "message";
  agentId?: string;
  conversationId?: string;
  messages: Array<
    (MessageCreate & { client_message_id?: string }) | ApprovalCreate
  >;
}

interface ModeChangePayload {
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

interface ChangeCwdMessage {
  agentId?: string | null;
  conversationId?: string | null;
  cwd: string;
}

type InboundMessagePayload =
  | (MessageCreate & { client_message_id?: string })
  | ApprovalCreate;

type ServerMessage = WsProtocolCommand;
type InvalidInputCommand = {
  type: "__invalid_input";
  runtime: RuntimeScope;
  reason: string;
};
type ParsedServerMessage = ServerMessage | InvalidInputCommand;

type PendingApprovalResolver = {
  resolve: (response: ApprovalResponseBody) => void;
  reject: (reason: Error) => void;
  controlRequest?: ControlRequest;
};

type RecoveredPendingApproval = {
  approval: ApprovalRequest;
  controlRequest: ControlRequest;
};

type RecoveredApprovalState = {
  agentId: string;
  conversationId: string;
  approvalsByRequestId: Map<string, RecoveredPendingApproval>;
  pendingRequestIds: Set<string>;
  responsesByRequestId: Map<string, ApprovalResponseBody>;
};

type ListenerRuntime = {
  socket: WebSocket | null;
  heartbeatInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
  recoveredApprovalState: RecoveredApprovalState | null;
  /** Stable session ID for MessageEnvelope-based emissions (scoped to runtime lifecycle). */
  sessionId: string;
  /** Monotonic event sequence for all outbound status/protocol events. */
  eventSeqCounter: number;
  /** Last stop reason from completed run */
  lastStopReason: string | null;
  /** Whether currently processing a message */
  isProcessing: boolean;
  /** Active run metadata for reconnect snapshot state. */
  activeAgentId: string | null;
  activeConversationId: string | null;
  activeWorkingDirectory: string | null;
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  /** Abort controller for the currently active message turn. */
  activeAbortController: AbortController | null;
  /** True when an abort_message request has been issued for the active turn. */
  cancelRequested: boolean;
  /** Queue lifecycle tracking — parallel tracking layer, does not affect message processing. */
  queueRuntime: QueueRuntime;
  /** Correlates queued queue item ids to original inbound frames. */
  queuedMessagesByItemId: Map<string, IncomingMessage>;
  /** True while a queue drain pass is actively running. */
  queuePumpActive: boolean;
  /** Dedupes queue pump scheduling onto messageQueue chain. */
  queuePumpScheduled: boolean;
  /** Coalesces rapid queue mutations into a single update_queue emit. */
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  /** Queue backlog metric for state snapshot visibility. */
  pendingTurns: number;
  /** Optional debug hook for WS event logging. */
  onWsEvent?: StartListenerOptions["onWsEvent"];
  /** Prevent duplicate concurrent pending-approval recovery passes. */
  isRecoveringApprovals: boolean;
  /** Canonical loop phase for update_loop_status emission. */
  loopStatus: LoopStatus;
  /**
   * Correlates pending approval tool_call_ids to the originating dequeued batch.
   * Used to preserve run attachment continuity across approval recovery.
   */
  pendingApprovalBatchByToolCallId: Map<string, string>;
  /** Queued interrupted tool-call resolutions from a cancelled turn. Prepended to the next user message. */
  pendingInterruptedResults: Array<ApprovalResult> | null;
  /** Context for pendingInterruptedResults — prevents replay into wrong conversation. */
  pendingInterruptedContext: {
    agentId: string;
    conversationId: string;
    continuationEpoch: number;
  } | null;
  /** Monotonic epoch for queued continuation validity checks. */
  continuationEpoch: number;
  /**
   * Tool call ids currently executing in the active approval loop turn.
   * Used for eager cancel-time interrupt capture parity with App/headless.
   */
  activeExecutingToolCallIds: string[];
  /**
   * Structured interrupted tool_call_ids carried with queued interrupt approvals.
   * Threaded into the next send for persistence normalization.
   */
  pendingInterruptedToolCallIds: string[] | null;
  reminderState: SharedReminderState;
  bootWorkingDirectory: string;
  workingDirectoryByConversation: Map<string, string>;
  connectionId: string | null;
  connectionName: string | null;
};

// Listen mode supports one active connection per process.
let activeRuntime: ListenerRuntime | null = null;

/**
 * Handle mode change request from cloud
 */
function handleModeChange(
  msg: ModeChangePayload,
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  try {
    permissionMode.setMode(msg.mode);

    // If entering plan mode, generate and set plan file path
    if (msg.mode === "plan" && !permissionMode.getPlanFilePath()) {
      const planFilePath = generatePlanFilePath();
      permissionMode.setPlanFilePath(planFilePath);
    }

    emitDeviceStatusUpdate(socket, runtime, scope);

    if (isDebugEnabled()) {
      console.log(`[Listen] Mode changed to: ${msg.mode}`);
    }
  } catch (error) {
    emitLoopErrorDelta(socket, runtime, {
      message: error instanceof Error ? error.message : "Mode change failed",
      stopReason: "error",
      isTerminal: false,
      agentId: scope?.agent_id,
      conversationId: scope?.conversation_id,
    });

    if (isDebugEnabled()) {
      console.error("[Listen] Mode change failed:", error);
    }
  }
}

function normalizeCwdAgentId(agentId?: string | null): string | null {
  return agentId && agentId.length > 0 ? agentId : null;
}

function getWorkingDirectoryScopeKey(
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  if (normalizedConversationId === "default") {
    return `agent:${normalizedAgentId ?? "__unknown__"}::conversation:default`;
  }

  return `conversation:${normalizedConversationId}`;
}

async function handleCwdChange(
  msg: ChangeCwdMessage,
  socket: WebSocket,
  runtime: ListenerRuntime,
): Promise<void> {
  const conversationId = normalizeConversationId(msg.conversationId);
  const agentId = normalizeCwdAgentId(msg.agentId);
  const currentWorkingDirectory = getConversationWorkingDirectory(
    runtime,
    agentId,
    conversationId,
  );

  try {
    const requestedPath = msg.cwd?.trim();
    if (!requestedPath) {
      throw new Error("Working directory cannot be empty");
    }

    const resolvedPath = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(currentWorkingDirectory, requestedPath);
    const normalizedPath = await realpath(resolvedPath);
    const stats = await stat(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    setConversationWorkingDirectory(
      runtime,
      agentId,
      conversationId,
      normalizedPath,
    );
    emitDeviceStatusUpdate(socket, runtime, {
      agent_id: agentId,
      conversation_id: conversationId,
    });
  } catch (error) {
    emitLoopErrorDelta(socket, runtime, {
      message:
        error instanceof Error
          ? error.message
          : "Working directory change failed",
      stopReason: "error",
      isTerminal: false,
      agentId,
      conversationId,
    });
  }
}

const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

function getQueueItemScope(item?: QueueItem | null): {
  agent_id?: string;
  conversation_id?: string;
} {
  if (!item) {
    return {};
  }
  return {
    agent_id: item.agentId,
    conversation_id: item.conversationId,
  };
}

function getQueueItemsScope(items: QueueItem[]): {
  agent_id?: string;
  conversation_id?: string;
} {
  const first = items[0];
  if (!first) {
    return {};
  }
  const sameScope = items.every(
    (item) =>
      (item.agentId ?? null) === (first.agentId ?? null) &&
      (item.conversationId ?? null) === (first.conversationId ?? null),
  );
  return sameScope ? getQueueItemScope(first) : {};
}

function createRuntime(): ListenerRuntime {
  const bootWorkingDirectory = process.env.USER_CWD || process.cwd();
  const runtime: ListenerRuntime = {
    socket: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    recoveredApprovalState: null,
    sessionId: `listen-${crypto.randomUUID()}`,
    eventSeqCounter: 0,
    lastStopReason: null,
    isProcessing: false,
    activeAgentId: null,
    activeConversationId: null,
    activeWorkingDirectory: null,
    activeRunId: null,
    activeRunStartedAt: null,
    activeAbortController: null,
    cancelRequested: false,
    isRecoveringApprovals: false,
    loopStatus: "WAITING_ON_INPUT",
    pendingApprovalBatchByToolCallId: new Map<string, string>(),
    pendingInterruptedResults: null,
    pendingInterruptedContext: null,
    continuationEpoch: 0,
    activeExecutingToolCallIds: [],
    pendingInterruptedToolCallIds: null,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: loadPersistedCwdMap(),
    connectionId: null,
    connectionName: null,
    queuedMessagesByItemId: new Map<string, IncomingMessage>(),
    queuePumpActive: false,
    queuePumpScheduled: false,
    queueEmitScheduled: false,
    pendingQueueEmitScope: undefined,
    pendingTurns: 0,
    // queueRuntime assigned below — needs runtime ref in callbacks
    queueRuntime: null as unknown as QueueRuntime,
  };
  runtime.queueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        const scope = getQueueItemScope(item);
        scheduleQueueEmit(runtime, scope);
      },
      onDequeued: (batch) => {
        runtime.pendingTurns = batch.queueLenAfter;
        const scope = getQueueItemsScope(batch.items);
        scheduleQueueEmit(runtime, scope);
      },
      onBlocked: (_reason, _queueLen) => {
        const scope = getQueueItemScope(runtime.queueRuntime.items[0]);
        scheduleQueueEmit(runtime, scope);
      },
      onCleared: (_reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
        const scope = getQueueItemsScope(items);
        scheduleQueueEmit(runtime, scope);
      },
      onDropped: (item, _reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        const scope = getQueueItemScope(item);
        scheduleQueueEmit(runtime, scope);
      },
    },
  });
  return runtime;
}

function normalizeConversationId(conversationId?: string | null): string {
  return conversationId && conversationId.length > 0
    ? conversationId
    : "default";
}

function getConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  return (
    runtime.workingDirectoryByConversation.get(scopeKey) ??
    runtime.bootWorkingDirectory
  );
}

// ---------------------------------------------------------------------------
//  CWD persistence (opt-in via PERSIST_CWD=1, used by letta-code-desktop)
// ---------------------------------------------------------------------------

const shouldPersistCwd = process.env.PERSIST_CWD === "1";

function getCwdCachePath(): string {
  return path.join(homedir(), ".letta", "cwd-cache.json");
}

function loadPersistedCwdMap(): Map<string, string> {
  if (!shouldPersistCwd) return new Map();
  try {
    const cachePath = getCwdCachePath();
    if (!existsSync(cachePath)) return new Map();
    const raw = require("node:fs").readFileSync(cachePath, "utf-8") as string;
    const parsed = JSON.parse(raw) as Record<string, string>;
    // Validate entries: only keep directories that still exist
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && existsSync(value)) {
        map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function persistCwdMap(map: Map<string, string>): void {
  if (!shouldPersistCwd) return;
  const cachePath = getCwdCachePath();
  const obj: Record<string, string> = Object.fromEntries(map);
  // Fire-and-forget write, don't block the event loop
  void mkdir(path.dirname(cachePath), { recursive: true })
    .then(() => writeFile(cachePath, JSON.stringify(obj, null, 2)))
    .catch(() => {
      // Silently ignore write failures
    });
}

function setConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
  workingDirectory: string,
): void {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  if (workingDirectory === runtime.bootWorkingDirectory) {
    runtime.workingDirectoryByConversation.delete(scopeKey);
  } else {
    runtime.workingDirectoryByConversation.set(scopeKey, workingDirectory);
  }

  persistCwdMap(runtime.workingDirectoryByConversation);
}

function clearRuntimeTimers(runtime: ListenerRuntime): void {
  if (runtime.reconnectTimeout) {
    clearTimeout(runtime.reconnectTimeout);
    runtime.reconnectTimeout = null;
  }
  if (runtime.heartbeatInterval) {
    clearInterval(runtime.heartbeatInterval);
    runtime.heartbeatInterval = null;
  }
}

function clearActiveRunState(runtime: ListenerRuntime): void {
  runtime.activeAgentId = null;
  runtime.activeConversationId = null;
  runtime.activeWorkingDirectory = null;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = null;
  runtime.activeAbortController = null;
}

function clearRecoveredApprovalState(runtime: ListenerRuntime): void {
  runtime.recoveredApprovalState = null;
}

function clearRecoveredApprovalStateForScope(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const recovered = getRecoveredApprovalStateForScope(runtime, params);
  if (recovered) {
    clearRecoveredApprovalState(runtime);
  }
}

function getRecoveredApprovalStateForScope(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): RecoveredApprovalState | null {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  if (!scopedAgentId) {
    return null;
  }
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const recovered = runtime.recoveredApprovalState;
  if (!recovered) {
    return null;
  }
  return recovered.agentId === scopedAgentId &&
    recovered.conversationId === scopedConversationId
    ? recovered
    : null;
}

function getPendingControlRequests(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): PendingControlRequest[] {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const requests: PendingControlRequest[] = [];

  for (const pending of runtime.pendingApprovalResolvers.values()) {
    const request = pending.controlRequest;
    if (!request) continue;
    if (
      scopedAgentId &&
      (request.agent_id ?? scopedAgentId) !== scopedAgentId
    ) {
      continue;
    }
    if (
      scopedConversationId &&
      (request.conversation_id ?? scopedConversationId) !== scopedConversationId
    ) {
      continue;
    }
    requests.push({
      request_id: request.request_id,
      request: request.request,
    });
  }

  const recovered = getRecoveredApprovalStateForScope(runtime, params);
  if (recovered) {
    for (const requestId of recovered.pendingRequestIds) {
      const entry = recovered.approvalsByRequestId.get(requestId);
      if (!entry) continue;
      requests.push({
        request_id: entry.controlRequest.request_id,
        request: entry.controlRequest.request,
      });
    }
  }

  return requests;
}

function getPendingControlRequestCount(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): number {
  return getPendingControlRequests(runtime, params).length;
}

function emitRuntimeStateUpdates(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  emitLoopStatusIfOpen(runtime, scope);
  emitDeviceStatusIfOpen(runtime, scope);
}

function rememberPendingApprovalBatchIds(
  runtime: ListenerRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
  batchId: string,
): void {
  for (const approval of pendingApprovals) {
    if (approval.toolCallId) {
      runtime.pendingApprovalBatchByToolCallId.set(
        approval.toolCallId,
        batchId,
      );
    }
  }
}

function resolvePendingApprovalBatchId(
  runtime: ListenerRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
): string | null {
  const batchIds = new Set<string>();
  for (const approval of pendingApprovals) {
    const batchId = runtime.pendingApprovalBatchByToolCallId.get(
      approval.toolCallId,
    );
    // Fail closed: every pending approval must have an originating batch mapping.
    if (!batchId) {
      return null;
    }
    batchIds.add(batchId);
  }
  if (batchIds.size !== 1) {
    return null;
  }
  return batchIds.values().next().value ?? null;
}

/**
 * Resolve the batch ID for pending approval recovery.
 * Cold start (empty map): returns a synthetic batch ID.
 * Warm (map has entries): delegates to resolvePendingApprovalBatchId,
 * returning null for ambiguous/conflicting mappings (fail-closed).
 */
function resolveRecoveryBatchId(
  runtime: ListenerRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
): string | null {
  if (runtime.pendingApprovalBatchByToolCallId.size === 0) {
    return `recovery-${crypto.randomUUID()}`;
  }
  return resolvePendingApprovalBatchId(runtime, pendingApprovals);
}

function clearPendingApprovalBatchIds(
  runtime: ListenerRuntime,
  approvals: Array<{ toolCallId: string }>,
): void {
  for (const approval of approvals) {
    runtime.pendingApprovalBatchByToolCallId.delete(approval.toolCallId);
  }
}

function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  runtime.intentionallyClosed = true;
  runtime.cancelRequested = true;
  if (
    runtime.activeAbortController &&
    !runtime.activeAbortController.signal.aborted
  ) {
    runtime.activeAbortController.abort();
  }
  clearRuntimeTimers(runtime);
  rejectPendingApprovalResolvers(runtime, "Listener runtime stopped");
  runtime.pendingApprovalBatchByToolCallId.clear();

  // Clear interrupted queue on true teardown to prevent cross-session leakage.
  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  runtime.activeExecutingToolCallIds = [];
  runtime.loopStatus = "WAITING_ON_INPUT";
  runtime.continuationEpoch++;

  if (!runtime.socket) {
    return;
  }

  const socket = runtime.socket;
  runtime.socket = null;

  // Stale runtimes being replaced should not emit callbacks/retries.
  if (suppressCallbacks) {
    socket.removeAllListeners();
  }

  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

function isValidApprovalResponseBody(
  value: unknown,
): value is ApprovalResponseBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeResponse = value as {
    request_id?: unknown;
    decision?: unknown;
    error?: unknown;
  };
  if (typeof maybeResponse.request_id !== "string") {
    return false;
  }
  if (maybeResponse.error !== undefined) {
    return typeof maybeResponse.error === "string";
  }
  if (!maybeResponse.decision || typeof maybeResponse.decision !== "object") {
    return false;
  }
  const decision = maybeResponse.decision as {
    behavior?: unknown;
    message?: unknown;
    updated_input?: unknown;
    updated_permissions?: unknown;
  };
  if (decision.behavior === "allow") {
    const hasUpdatedInput =
      decision.updated_input === undefined ||
      decision.updated_input === null ||
      typeof decision.updated_input === "object";
    const hasUpdatedPermissions =
      decision.updated_permissions === undefined ||
      (Array.isArray(decision.updated_permissions) &&
        decision.updated_permissions.every(
          (entry) => typeof entry === "string",
        ));
    return hasUpdatedInput && hasUpdatedPermissions;
  }
  if (decision.behavior === "deny") {
    return typeof decision.message === "string";
  }
  return false;
}

function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { agent_id?: unknown; conversation_id?: unknown };
  return (
    typeof candidate.agent_id === "string" &&
    candidate.agent_id.length > 0 &&
    typeof candidate.conversation_id === "string" &&
    candidate.conversation_id.length > 0
  );
}

function isInputCommand(value: unknown): value is InputCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (candidate.type !== "input" || !isRuntimeScope(candidate.runtime)) {
    return false;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }

  const payload = candidate.payload as {
    kind?: unknown;
    messages?: unknown;
    request_id?: unknown;
    decision?: unknown;
    error?: unknown;
  };
  if (payload.kind === "create_message") {
    return Array.isArray(payload.messages);
  }
  if (payload.kind === "approval_response") {
    return isValidApprovalResponseBody(payload);
  }
  return false;
}

function getInvalidInputReason(value: unknown): {
  runtime: RuntimeScope;
  reason: string;
} | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (candidate.type !== "input" || !isRuntimeScope(candidate.runtime)) {
    return null;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return {
      runtime: candidate.runtime,
      reason: "Protocol violation: input.payload must be an object",
    };
  }
  const payload = candidate.payload as {
    kind?: unknown;
    messages?: unknown;
    request_id?: unknown;
    decision?: unknown;
    error?: unknown;
  };
  if (payload.kind === "create_message") {
    if (!Array.isArray(payload.messages)) {
      return {
        runtime: candidate.runtime,
        reason:
          "Protocol violation: input.kind=create_message requires payload.messages[]",
      };
    }
    return null;
  }
  if (payload.kind === "approval_response") {
    if (!isValidApprovalResponseBody(payload)) {
      return {
        runtime: candidate.runtime,
        reason:
          "Protocol violation: input.kind=approval_response requires payload.request_id and either payload.decision or payload.error",
      };
    }
    return null;
  }
  return {
    runtime: candidate.runtime,
    reason: `Unsupported input payload kind: ${String(payload.kind)}`,
  };
}

function isChangeDeviceStateCommand(
  value: unknown,
): value is ChangeDeviceStateCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (
    candidate.type !== "change_device_state" ||
    !isRuntimeScope(candidate.runtime)
  ) {
    return false;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as {
    mode?: unknown;
    cwd?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
  };
  const hasMode =
    payload.mode === undefined || typeof payload.mode === "string";
  const hasCwd = payload.cwd === undefined || typeof payload.cwd === "string";
  const hasAgentId =
    payload.agent_id === undefined ||
    payload.agent_id === null ||
    typeof payload.agent_id === "string";
  const hasConversationId =
    payload.conversation_id === undefined ||
    payload.conversation_id === null ||
    typeof payload.conversation_id === "string";
  return hasMode && hasCwd && hasAgentId && hasConversationId;
}

function isAbortMessageCommand(value: unknown): value is AbortMessageCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    request_id?: unknown;
    run_id?: unknown;
  };
  if (
    candidate.type !== "abort_message" ||
    !isRuntimeScope(candidate.runtime)
  ) {
    return false;
  }
  const hasRequestId =
    candidate.request_id === undefined ||
    typeof candidate.request_id === "string";
  const hasRunId =
    candidate.run_id === undefined ||
    candidate.run_id === null ||
    typeof candidate.run_id === "string";
  return hasRequestId && hasRunId;
}

function isSyncCommand(value: unknown): value is SyncCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
  };
  return candidate.type === "sync" && isRuntimeScope(candidate.runtime);
}

export function parseServerMessage(
  data: WebSocket.RawData,
): ParsedServerMessage | null {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    const parsed = JSON.parse(raw) as unknown;
    if (
      isInputCommand(parsed) ||
      isChangeDeviceStateCommand(parsed) ||
      isAbortMessageCommand(parsed) ||
      isSyncCommand(parsed)
    ) {
      return parsed;
    }
    const invalidInput = getInvalidInputReason(parsed);
    if (invalidInput) {
      return {
        type: "__invalid_input",
        runtime: invalidInput.runtime,
        reason: invalidInput.reason,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Fire onWsEvent without risking transport disruption. */
function safeEmitWsEvent(
  direction: "send" | "recv",
  label: "client" | "protocol" | "control" | "lifecycle",
  event: unknown,
): void {
  try {
    activeRuntime?.onWsEvent?.(direction, label, event);
  } catch {
    // Debug hook must never break transport flow.
  }
}

function nextEventSeq(runtime: ListenerRuntime | null): number | null {
  if (!runtime) {
    return null;
  }
  runtime.eventSeqCounter += 1;
  return runtime.eventSeqCounter;
}

function getQueueItemContent(item: QueueItem): QueueMessage["content"] {
  return item.kind === "message" ? item.content : item.text;
}

function mergeDequeuedBatchContent(
  items: QueueItem[],
): MessageCreate["content"] | null {
  const queuedInputs: Array<
    | { kind: "user"; content: MessageCreate["content"] }
    | {
        kind: "task_notification";
        text: string;
      }
  > = [];

  for (const item of items) {
    if (item.kind === "message") {
      queuedInputs.push({
        kind: "user",
        content: item.content,
      });
      continue;
    }
    if (item.kind === "task_notification") {
      queuedInputs.push({
        kind: "task_notification",
        text: item.text,
      });
    }
  }

  return mergeQueuedTurnInput(queuedInputs, {
    normalizeUserContent: (content) => content,
  });
}

function isBase64ImageContentPart(part: unknown): part is {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
} {
  if (!part || typeof part !== "object") {
    return false;
  }

  const candidate = part as {
    type?: unknown;
    source?: {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };
  };

  return (
    candidate.type === "image" &&
    !!candidate.source &&
    candidate.source.type === "base64" &&
    typeof candidate.source.media_type === "string" &&
    candidate.source.media_type.length > 0 &&
    typeof candidate.source.data === "string" &&
    candidate.source.data.length > 0
  );
}

async function normalizeMessageContentImages(
  content: MessageCreate["content"],
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
): Promise<MessageCreate["content"]> {
  if (typeof content === "string") {
    return content;
  }

  let didChange = false;
  const normalizedParts = await Promise.all(
    content.map(async (part) => {
      if (!isBase64ImageContentPart(part)) {
        return part;
      }

      const resized = await resize(
        Buffer.from(part.source.data, "base64"),
        part.source.media_type,
      );
      if (
        resized.data !== part.source.data ||
        resized.mediaType !== part.source.media_type
      ) {
        didChange = true;
      }

      return {
        ...part,
        source: {
          ...part.source,
          type: "base64" as const,
          data: resized.data,
          media_type: resized.mediaType,
        },
      };
    }),
  );

  return didChange ? normalizedParts : content;
}

async function normalizeInboundMessages(
  messages: InboundMessagePayload[],
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
): Promise<InboundMessagePayload[]> {
  let didChange = false;

  const normalizedMessages = await Promise.all(
    messages.map(async (message) => {
      if (!("content" in message)) {
        return message;
      }

      const normalizedContent = await normalizeMessageContentImages(
        message.content,
        resize,
      );
      if (normalizedContent !== message.content) {
        didChange = true;
        return {
          ...message,
          content: normalizedContent,
        };
      }
      return message;
    }),
  );

  return didChange ? normalizedMessages : messages;
}

function getPrimaryQueueMessageItem(items: QueueItem[]): QueueItem | null {
  for (const item of items) {
    if (item.kind === "message") {
      return item;
    }
  }
  return null;
}

function buildQueuedTurnMessage(
  runtime: ListenerRuntime,
  batch: DequeuedBatch,
): IncomingMessage | null {
  const primaryItem = getPrimaryQueueMessageItem(batch.items);
  if (!primaryItem) {
    for (const item of batch.items) {
      runtime.queuedMessagesByItemId.delete(item.id);
    }
    return null;
  }

  const template = runtime.queuedMessagesByItemId.get(primaryItem.id);
  for (const item of batch.items) {
    runtime.queuedMessagesByItemId.delete(item.id);
  }
  if (!template) {
    return null;
  }

  const mergedContent = mergeDequeuedBatchContent(batch.items);
  if (mergedContent === null) {
    return null;
  }

  const firstMessageIndex = template.messages.findIndex(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (firstMessageIndex === -1) {
    return null;
  }

  const firstMessage = template.messages[firstMessageIndex] as MessageCreate & {
    client_message_id?: string;
  };
  const mergedFirstMessage = {
    ...firstMessage,
    content: mergedContent,
  };
  const messages = template.messages.slice();
  messages[firstMessageIndex] = mergedFirstMessage;

  return {
    ...template,
    messages,
  };
}

function shouldQueueInboundMessage(parsed: IncomingMessage): boolean {
  return parsed.messages.some((payload) => "content" in payload);
}

function computeListenerQueueBlockedReason(
  runtime: ListenerRuntime,
): QueueBlockedReason | null {
  const activeScope = resolveRuntimeScope(runtime);
  return getListenerBlockedReason({
    isProcessing: runtime.isProcessing,
    pendingApprovalsLen: activeScope
      ? getPendingControlRequestCount(runtime, activeScope)
      : 0,
    cancelRequested: runtime.cancelRequested,
    isRecoveringApprovals: runtime.isRecoveringApprovals,
  });
}

async function drainQueuedMessages(
  runtime: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
): Promise<void> {
  if (runtime.queuePumpActive) {
    return;
  }

  runtime.queuePumpActive = true;
  try {
    while (true) {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      const blockedReason = computeListenerQueueBlockedReason(runtime);
      if (blockedReason) {
        runtime.queueRuntime.tryDequeue(blockedReason);
        return;
      }

      const queueLen = runtime.queueRuntime.length;
      if (queueLen === 0) {
        return;
      }

      const dequeuedBatch = runtime.queueRuntime.consumeItems(queueLen);
      if (!dequeuedBatch) {
        return;
      }

      const queuedTurn = buildQueuedTurnMessage(runtime, dequeuedBatch);
      if (!queuedTurn) {
        continue;
      }

      // Emit the user message as a stream_delta so the web can display it
      // immediately when the turn starts (before the API call).
      emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);

      opts.onStatusChange?.("receiving", opts.connectionId);
      await handleIncomingMessage(
        queuedTurn,
        socket,
        runtime,
        opts.onStatusChange,
        opts.connectionId,
        dequeuedBatch.batchId,
      );
      opts.onStatusChange?.("idle", opts.connectionId);
    }
  } finally {
    runtime.queuePumpActive = false;
  }
}

function scheduleQueuePump(
  runtime: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
): void {
  if (runtime.queuePumpScheduled) {
    return;
  }
  runtime.queuePumpScheduled = true;
  runtime.messageQueue = runtime.messageQueue
    .then(async () => {
      runtime.queuePumpScheduled = false;
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }
      await drainQueuedMessages(runtime, socket, opts);
    })
    .catch((error: unknown) => {
      runtime.queuePumpScheduled = false;
      if (isDebugEnabled()) {
        console.error("[Listen] Error in queue pump:", error);
      }
      opts.onStatusChange?.("idle", opts.connectionId);
    });
}

function resolveScopedAgentId(
  runtime: ListenerRuntime | null,
  params?: {
    agent_id?: string | null;
  },
): string | null {
  return (
    normalizeCwdAgentId(params?.agent_id) ?? runtime?.activeAgentId ?? null
  );
}

function resolveScopedConversationId(
  runtime: ListenerRuntime | null,
  params?: {
    conversation_id?: string | null;
  },
): string {
  return normalizeConversationId(
    params?.conversation_id ?? runtime?.activeConversationId,
  );
}

function resolveRuntimeScope(
  runtime: ListenerRuntime | null,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): RuntimeScope | null {
  const resolvedAgentId = resolveScopedAgentId(runtime, params);
  if (!resolvedAgentId) {
    return null;
  }
  const resolvedConversationId = resolveScopedConversationId(runtime, params);
  return {
    agent_id: resolvedAgentId,
    conversation_id: resolvedConversationId,
  };
}

/**
 * Returns true when the requested scope matches the conversation that is
 * currently executing on the device.  When the device is idle (not processing)
 * every scope is trivially "active" — the flag is only meaningful while a run
 * is in progress, so we return `true` for the idle case to let callers report
 * the real (idle) device state rather than a synthetic zero state.
 */
function isScopeCurrentlyActive(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
): boolean {
  if (!runtime.isProcessing) return true;

  const activeAgent = runtime.activeAgentId;
  const activeConvo = normalizeConversationId(runtime.activeConversationId);

  if (agentId && activeAgent && agentId !== activeAgent) return false;
  if (conversationId !== activeConvo) return false;

  return true;
}

function buildDeviceStatus(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): DeviceStatus {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const scopeActive = isScopeCurrentlyActive(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  const toolsetPreference = (() => {
    if (!scopedAgentId) {
      return "auto" as const;
    }
    try {
      return settingsManager.getToolsetPreference(scopedAgentId);
    } catch {
      // Tests and early boot can query status before settings are initialized.
      return "auto" as const;
    }
  })();
  return {
    current_connection_id: runtime.connectionId,
    connection_name: runtime.connectionName,
    is_online: runtime.socket?.readyState === WebSocket.OPEN,
    is_processing: scopeActive && runtime.isProcessing,
    current_permission_mode: permissionMode.getMode(),
    current_working_directory: getConversationWorkingDirectory(
      runtime,
      scopedAgentId,
      scopedConversationId,
    ),
    letta_code_version: process.env.npm_package_version || null,
    current_toolset: toolsetPreference === "auto" ? null : toolsetPreference,
    current_toolset_preference: toolsetPreference,
    current_loaded_tools: getToolNames(),
    current_available_skills: [],
    background_processes: [],
    pending_control_requests: getPendingControlRequests(runtime, params),
  };
}

function buildLoopStatus(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): LoopState {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const scopeActive = isScopeCurrentlyActive(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );

  // If the requested scope is NOT the one currently executing, report idle.
  if (!scopeActive) {
    return { status: "WAITING_ON_INPUT", active_run_ids: [] };
  }

  const recovered = getRecoveredApprovalStateForScope(runtime, params);
  const status =
    recovered &&
    recovered.pendingRequestIds.size > 0 &&
    runtime.loopStatus === "WAITING_ON_INPUT"
      ? "WAITING_ON_APPROVAL"
      : runtime.loopStatus;
  return {
    status,
    active_run_ids: runtime.activeRunId ? [runtime.activeRunId] : [],
  };
}

function buildQueueSnapshot(runtime: ListenerRuntime): QueueMessage[] {
  return runtime.queueRuntime.items.map((item) => ({
    id: item.id,
    client_message_id: item.clientMessageId ?? `cm-${item.id}`,
    kind: item.kind,
    source: item.source,
    content: getQueueItemContent(item),
    enqueued_at: new Date(item.enqueuedAt).toISOString(),
  }));
}

function isApprovalOnlyInput(
  input: Array<MessageCreate | ApprovalCreate>,
): boolean {
  return (
    input.length === 1 &&
    input[0] !== undefined &&
    "type" in input[0] &&
    input[0].type === "approval"
  );
}

function markAwaitingAcceptedApprovalContinuationRunId(
  runtime: ListenerRuntime,
  input: Array<MessageCreate | ApprovalCreate>,
): void {
  if (isApprovalOnlyInput(input)) {
    runtime.activeRunId = null;
  }
}

function setLoopStatus(
  runtime: ListenerRuntime,
  status: LoopStatus,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.loopStatus === status) {
    return;
  }
  runtime.loopStatus = status;
  emitLoopStatusIfOpen(runtime, scope);
}

function emitProtocolV2Message(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  message: Omit<
    WsProtocolMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  >,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const runtimeScope = resolveRuntimeScope(runtime, scope);
  if (!runtimeScope) {
    return;
  }
  const eventSeq = nextEventSeq(runtime);
  if (eventSeq === null) {
    return;
  }
  const outbound: WsProtocolMessage = {
    ...message,
    runtime: runtimeScope,
    event_seq: eventSeq,
    emitted_at: new Date().toISOString(),
    idempotency_key: `${message.type}:${eventSeq}:${crypto.randomUUID()}`,
  } as WsProtocolMessage;
  try {
    socket.send(JSON.stringify(outbound));
  } catch (error) {
    console.error(
      `[Listen V2] Failed to emit ${message.type} (seq=${eventSeq})`,
      error,
    );
    safeEmitWsEvent("send", "lifecycle", {
      type: "_ws_send_error",
      message_type: message.type,
      event_seq: eventSeq,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  console.log(`[Listen V2] Emitting ${message.type} (seq=${eventSeq})`);
  safeEmitWsEvent("send", "protocol", outbound);
}

function emitDeviceStatusUpdate(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    DeviceStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_device_status",
    device_status: buildDeviceStatus(runtime, scope),
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

function emitLoopStatusUpdate(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    LoopStatusUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_loop_status",
    loop_status: buildLoopStatus(runtime, scope),
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

function emitLoopStatusIfOpen(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) {
    emitLoopStatusUpdate(runtime.socket, runtime, scope);
  }
}

function emitDeviceStatusIfOpen(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) {
    emitDeviceStatusUpdate(runtime.socket, runtime, scope);
  }
}

function emitQueueUpdate(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const scopedAgentId = resolveScopedAgentId(runtime, scope);
  const scopedConversationId = resolveScopedConversationId(runtime, scope);
  const scopeActive = isScopeCurrentlyActive(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );

  const message: Omit<
    QueueUpdateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "update_queue",
    queue: scopeActive ? buildQueueSnapshot(runtime) : [],
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function isSystemReminderPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  if (!("type" in part) || (part as { type: string }).type !== "text")
    return false;
  if (!("text" in part) || typeof (part as { text: string }).text !== "string")
    return false;
  const trimmed = (part as { text: string }).text.trim();
  return (
    trimmed.startsWith("<system-reminder>") &&
    trimmed.endsWith("</system-reminder>")
  );
}

/**
 * Emit a synthetic user_message stream_delta when a queued turn is about to
 * be submitted to the API. This lets the web display the user message
 * immediately in the transcript without waiting for a poll or API echo.
 *
 * Preserves the original content format (string → string, array → array)
 * and strips system-reminder content before emitting.
 *
 * The client_message_id from the original submit payload is used as the otid
 * so that the optimistic message (if any) gets deduplicated.
 */
function emitDequeuedUserMessage(
  socket: WebSocket,
  runtime: ListenerRuntime,
  incoming: IncomingMessage,
  batch: DequeuedBatch,
): void {
  const firstUserPayload = incoming.messages.find(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (!firstUserPayload) return;

  const rawContent = firstUserPayload.content;
  let content: MessageCreate["content"];

  if (typeof rawContent === "string") {
    // String content — strip system-reminder blocks via regex
    content = rawContent.replace(SYSTEM_REMINDER_RE, "").trim();
  } else if (Array.isArray(rawContent)) {
    // Array content — filter out system-reminder text parts
    content = rawContent.filter((part) => !isSystemReminderPart(part));
  } else {
    return;
  }

  // Check if there's meaningful content left
  const hasContent =
    typeof content === "string"
      ? content.length > 0
      : Array.isArray(content) && content.length > 0;
  if (!hasContent) return;

  const otid = firstUserPayload.client_message_id ?? batch.batchId;

  emitCanonicalMessageDelta(
    socket,
    runtime,
    {
      type: "message",
      id: `user-msg-${crypto.randomUUID()}`,
      date: new Date().toISOString(),
      message_type: "user_message",
      content,
      otid,
    } as StreamDelta,
    {
      agent_id: incoming.agentId,
      conversation_id: incoming.conversationId,
    },
  );
}

function emitQueueUpdateIfOpen(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) {
    emitQueueUpdate(runtime.socket, runtime, scope);
  }
}

function emitStateSync(
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope: RuntimeScope,
): void {
  emitDeviceStatusUpdate(socket, runtime, scope);
  emitLoopStatusUpdate(socket, runtime, scope);
  emitQueueUpdate(socket, runtime, scope);
}

/**
 * Coalesces rapid queue mutations into a single `update_queue` emit.
 * Uses `queueMicrotask` so that enqueue + immediate dequeue within the
 * same tick produce only one WS message with the final queue state,
 * preventing a visible flash of transient queue items.
 */
function scheduleQueueEmit(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  // Last writer wins — keep the most recent scope
  runtime.pendingQueueEmitScope = scope;

  if (runtime.queueEmitScheduled) return;
  runtime.queueEmitScheduled = true;

  queueMicrotask(() => {
    runtime.queueEmitScheduled = false;
    const emitScope = runtime.pendingQueueEmitScope;
    runtime.pendingQueueEmitScope = undefined;
    emitQueueUpdateIfOpen(runtime, emitScope);
  });
}

function createLifecycleMessageBase<TMessageType extends string>(
  messageType: TMessageType,
  runId?: string | null,
): {
  id: string;
  date: string;
  message_type: TMessageType;
  run_id?: string;
} {
  return {
    id: `message-${crypto.randomUUID()}`,
    date: new Date().toISOString(),
    message_type: messageType,
    ...(runId ? { run_id: runId } : {}),
  };
}

function emitCanonicalMessageDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  delta: StreamDelta,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  emitStreamDelta(socket, runtime, delta, scope);
}

function emitLoopErrorDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  params: {
    message: string;
    stopReason: StopReasonType;
    isTerminal: boolean;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  emitCanonicalMessageDelta(
    socket,
    runtime,
    {
      ...createLifecycleMessageBase("loop_error", params.runId),
      message: params.message,
      stop_reason: params.stopReason,
      is_terminal: params.isTerminal,
    } as StreamDelta,
    {
      agent_id: params.agentId,
      conversation_id: params.conversationId,
    },
  );
}

function emitRetryDelta(
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    message: string;
    reason: StopReasonType;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  const delta: RetryMessage = {
    ...createLifecycleMessageBase("retry", params.runId),
    message: params.message,
    reason: params.reason,
    attempt: params.attempt,
    max_attempts: params.maxAttempts,
    delay_ms: params.delayMs,
  };
  emitCanonicalMessageDelta(socket, runtime, delta, {
    agent_id: params.agentId,
    conversation_id: params.conversationId,
  });
}

function emitStatusDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  params: {
    message: string;
    level: StatusMessage["level"];
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  const delta: StatusMessage = {
    ...createLifecycleMessageBase("status", params.runId),
    message: params.message,
    level: params.level,
  };
  emitCanonicalMessageDelta(socket, runtime, delta, {
    agent_id: params.agentId,
    conversation_id: params.conversationId,
  });
}

export function emitInterruptedStatusDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  params: {
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  emitStatusDelta(socket, runtime, {
    message: "Interrupted",
    level: "warning",
    runId: params.runId,
    agentId: params.agentId ?? undefined,
    conversationId: params.conversationId ?? undefined,
  });
}

function emitStreamDelta(
  socket: WebSocket,
  runtime: ListenerRuntime | null,
  delta: StreamDelta,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const message: Omit<
    StreamDeltaMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "stream_delta",
    delta,
  };
  emitProtocolV2Message(socket, runtime, message, scope);
}

const LLM_API_ERROR_MAX_RETRIES = 3;
const EMPTY_RESPONSE_MAX_RETRIES = 2;
const MAX_PRE_STREAM_RECOVERY = 2;
const MAX_POST_STOP_APPROVAL_RECOVERY = 2;
const NO_AWAITING_APPROVAL_DETAIL_FRAGMENT =
  "no tool call is currently awaiting approval";

function isApprovalToolCallDesyncError(detail: unknown): boolean {
  if (isInvalidToolCallIdsError(detail) || isApprovalPendingError(detail)) {
    return true;
  }
  return (
    typeof detail === "string" &&
    detail.toLowerCase().includes(NO_AWAITING_APPROVAL_DETAIL_FRAGMENT)
  );
}

function shouldAttemptPostStopApprovalRecovery(params: {
  stopReason: string | null | undefined;
  runIdsSeen: number;
  retries: number;
  runErrorDetail: string | null;
  latestErrorText: string | null;
}): boolean {
  const approvalDesyncDetected =
    isApprovalToolCallDesyncError(params.runErrorDetail) ||
    isApprovalToolCallDesyncError(params.latestErrorText);

  // Heuristic fallback:
  // If the stream stops with generic "error" before any run_id was emitted,
  // this is frequently a stale approval conflict after reconnect/interrupt.
  const genericNoRunError =
    params.stopReason === "error" && params.runIdsSeen === 0;

  return shouldAttemptApprovalRecovery({
    approvalPendingDetected: approvalDesyncDetected || genericNoRunError,
    retries: params.retries,
    maxRetries: MAX_POST_STOP_APPROVAL_RECOVERY,
  });
}

async function isRetriablePostStopError(
  stopReason: StopReasonType,
  lastRunId: string | null | undefined,
): Promise<boolean> {
  if (stopReason === "llm_api_error") {
    return true;
  }

  const nonRetriableReasons: StopReasonType[] = [
    "cancelled",
    "requires_approval",
    "max_steps",
    "max_tokens_exceeded",
    "context_window_overflow_in_system_prompt",
    "end_turn",
    "tool_rule",
    "no_tool_call",
  ];
  if (nonRetriableReasons.includes(stopReason)) {
    return false;
  }

  if (!lastRunId) {
    return false;
  }

  try {
    const client = await getClient();
    const run = await client.runs.retrieve(lastRunId);
    const metaError = run.metadata?.error as
      | {
          error_type?: string;
          detail?: string;
          error?: { error_type?: string; detail?: string };
        }
      | undefined;

    const errorType = metaError?.error_type ?? metaError?.error?.error_type;
    const detail = metaError?.detail ?? metaError?.error?.detail ?? "";
    return shouldRetryRunMetadataError(errorType, detail);
  } catch {
    return false;
  }
}

async function drainRecoveryStreamWithEmission(
  recoveryStream: Stream<LettaStreamingResponse>,
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    agentId?: string | null;
    conversationId: string;
    abortSignal: AbortSignal;
  },
): Promise<Awaited<ReturnType<typeof drainStreamWithResume>>> {
  let recoveryRunIdSent = false;

  return drainStreamWithResume(
    recoveryStream,
    createBuffers(params.agentId || ""),
    () => {},
    params.abortSignal,
    undefined,
    ({ chunk, shouldOutput, errorInfo }) => {
      const maybeRunId = (chunk as { run_id?: unknown }).run_id;
      if (typeof maybeRunId === "string") {
        if (runtime.activeRunId !== maybeRunId) {
          runtime.activeRunId = maybeRunId;
        }
        if (!recoveryRunIdSent) {
          recoveryRunIdSent = true;
          emitLoopStatusUpdate(socket, runtime, {
            agent_id: params.agentId ?? undefined,
            conversation_id: params.conversationId,
          });
        }
      }

      if (errorInfo) {
        emitLoopErrorDelta(socket, runtime, {
          message: errorInfo.message || "Stream error",
          stopReason: (errorInfo.error_type as StopReasonType) || "error",
          isTerminal: false,
          runId: runtime.activeRunId || errorInfo.run_id,
          agentId: params.agentId ?? undefined,
          conversationId: params.conversationId,
        });
      }

      if (shouldOutput) {
        const normalizedChunk = normalizeToolReturnWireMessage(
          chunk as unknown as Record<string, unknown>,
        );
        if (normalizedChunk) {
          emitCanonicalMessageDelta(
            socket,
            runtime,
            {
              ...normalizedChunk,
              type: "message",
            } as StreamDelta,
            {
              agent_id: params.agentId ?? undefined,
              conversation_id: params.conversationId,
            },
          );
        }
      }

      return undefined;
    },
  );
}

function finalizeHandledRecoveryTurn(
  runtime: ListenerRuntime,
  socket: WebSocket,
  params: {
    drainResult: Awaited<ReturnType<typeof drainStreamWithResume>>;
    agentId?: string | null;
    conversationId: string;
  },
): void {
  const scope = {
    agent_id: params.agentId ?? null,
    conversation_id: params.conversationId,
  };

  if (params.drainResult.stopReason === "end_turn") {
    runtime.lastStopReason = "end_turn";
    runtime.isProcessing = false;
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return;
  }

  if (params.drainResult.stopReason === "cancelled") {
    runtime.lastStopReason = "cancelled";
    runtime.isProcessing = false;
    emitInterruptedStatusDelta(socket, runtime, {
      runId: runtime.activeRunId,
      agentId: params.agentId ?? undefined,
      conversationId: params.conversationId,
    });
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return;
  }

  const terminalStopReason =
    (params.drainResult.stopReason as StopReasonType) || "error";
  runtime.lastStopReason = terminalStopReason;
  runtime.isProcessing = false;
  setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
  const runId = runtime.activeRunId;
  clearActiveRunState(runtime);
  emitRuntimeStateUpdates(runtime, scope);
  emitLoopErrorDelta(socket, runtime, {
    message: `Recovery continuation ended unexpectedly: ${terminalStopReason}`,
    stopReason: terminalStopReason,
    isTerminal: true,
    runId: runId || undefined,
    agentId: params.agentId ?? undefined,
    conversationId: params.conversationId,
  });
}

// ---------------------------------------------------------------------------
// Interrupt queue helpers — extracted for testability.
// These are the ONLY places that read/write pendingInterruptedResults.
// ---------------------------------------------------------------------------

interface InterruptPopulateInput {
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  agentId: string;
  conversationId: string;
}

interface InterruptToolReturn {
  tool_call_id: string;
  status: "success" | "error";
  tool_return: string;
  stdout?: string[];
  stderr?: string[];
}

function asToolReturnStatus(value: unknown): "success" | "error" | null {
  if (value === "success" || value === "error") {
    return value;
  }
  return null;
}

function normalizeToolReturnValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const textParts = value
      .filter(
        (
          part,
        ): part is {
          type: string;
          text: string;
        } =>
          !!part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string",
      )
      .map((part) => part.text);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return value.text;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getApprovalContinuationRecoveryDisposition(
  drainResult: Awaited<ReturnType<typeof drainStreamWithResume>> | null,
): "handled" | "retry" {
  return drainResult ? "handled" : "retry";
}

function normalizeInterruptedApprovalsForQueue(
  approvals: ApprovalResult[] | null,
  interruptedToolCallIds: string[],
): ApprovalResult[] | null {
  if (!approvals || approvals.length === 0) {
    return approvals;
  }

  return normalizeApprovalResultsForPersistence(approvals, {
    interruptedToolCallIds,
    // Temporary fallback guard while all producers migrate to structured IDs.
    allowInterruptTextFallback: true,
  });
}

function normalizeExecutionResultsForInterruptParity(
  runtime: ListenerRuntime,
  executionResults: ApprovalResult[],
  executingToolCallIds: string[],
): ApprovalResult[] {
  if (!runtime.cancelRequested || executionResults.length === 0) {
    return executionResults;
  }

  return normalizeApprovalResultsForPersistence(executionResults, {
    interruptedToolCallIds: executingToolCallIds,
  });
}

function collectApprovalResultToolCallIds(
  approvals: ApprovalResult[],
): string[] {
  return approvals
    .map((approval) => {
      if (
        approval &&
        typeof approval === "object" &&
        "tool_call_id" in approval &&
        typeof approval.tool_call_id === "string"
      ) {
        return approval.tool_call_id;
      }
      return null;
    })
    .filter((toolCallId): toolCallId is string => !!toolCallId);
}

function collectDecisionToolCallIds(
  decisions: Array<{
    approval: {
      toolCallId: string;
    };
  }>,
): string[] {
  return decisions
    .map((decision) => decision.approval.toolCallId)
    .filter((toolCallId) => toolCallId.length > 0);
}

function validateApprovalResultIds(
  decisions: Array<{
    approval: {
      toolCallId: string;
    };
  }>,
  approvals: ApprovalResult[],
): void {
  if (!process.env.DEBUG) {
    return;
  }

  const expectedIds = new Set(collectDecisionToolCallIds(decisions));
  const sendingIds = new Set(collectApprovalResultToolCallIds(approvals));
  const setsEqual =
    expectedIds.size === sendingIds.size &&
    [...expectedIds].every((toolCallId) => sendingIds.has(toolCallId));

  if (setsEqual) {
    return;
  }

  console.error(
    "[Listen][DEBUG] Approval ID mismatch detected",
    JSON.stringify(
      {
        expected: [...expectedIds],
        sending: [...sendingIds],
      },
      null,
      2,
    ),
  );
  throw new Error("Approval ID mismatch - refusing to send mismatched IDs");
}

async function debugLogApprovalResumeState(
  runtime: ListenerRuntime,
  params: {
    agentId: string;
    conversationId: string;
    expectedToolCallIds: string[];
    sentToolCallIds: string[];
  },
): Promise<void> {
  if (!process.env.DEBUG) {
    return;
  }

  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(params.agentId);
    const isExplicitConversation =
      params.conversationId.length > 0 && params.conversationId !== "default";
    const lastInContextId = isExplicitConversation
      ? ((
          await client.conversations.retrieve(params.conversationId)
        ).in_context_message_ids?.at(-1) ?? null)
      : (agent.message_ids?.at(-1) ?? null);
    const lastInContextMessages = lastInContextId
      ? await client.messages.retrieve(lastInContextId)
      : [];
    const resumeData = await getResumeData(
      client,
      agent,
      params.conversationId,
      {
        includeMessageHistory: false,
      },
    );

    console.log(
      "[Listen][DEBUG] Post-approval continuation resume snapshot",
      JSON.stringify(
        {
          conversationId: params.conversationId,
          activeRunId: runtime.activeRunId,
          expectedToolCallIds: params.expectedToolCallIds,
          sentToolCallIds: params.sentToolCallIds,
          pendingApprovalToolCallIds: (resumeData.pendingApprovals ?? []).map(
            (approval) => approval.toolCallId,
          ),
          lastInContextMessageId: lastInContextId,
          lastInContextMessageTypes: lastInContextMessages.map(
            (message) => message.message_type,
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.warn(
      "[Listen][DEBUG] Failed to capture post-approval resume snapshot:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function extractCanonicalToolReturnsFromWire(
  payload: Record<string, unknown>,
): InterruptToolReturn[] {
  const fromArray: InterruptToolReturn[] = [];
  const toolReturnsValue = payload.tool_returns;
  if (Array.isArray(toolReturnsValue)) {
    for (const raw of toolReturnsValue) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const rec = raw as Record<string, unknown>;
      const toolCallId =
        typeof rec.tool_call_id === "string" ? rec.tool_call_id : null;
      const status = asToolReturnStatus(rec.status);
      if (!toolCallId || !status) {
        continue;
      }
      const stdout = Array.isArray(rec.stdout)
        ? rec.stdout.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : undefined;
      const stderr = Array.isArray(rec.stderr)
        ? rec.stderr.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : undefined;
      fromArray.push({
        tool_call_id: toolCallId,
        status,
        tool_return: normalizeToolReturnValue(rec.tool_return),
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
      });
    }
  }
  if (fromArray.length > 0) {
    return fromArray;
  }

  const topLevelToolCallId =
    typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
  const topLevelStatus = asToolReturnStatus(payload.status);
  if (!topLevelToolCallId || !topLevelStatus) {
    return [];
  }
  const stdout = Array.isArray(payload.stdout)
    ? payload.stdout.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  const stderr = Array.isArray(payload.stderr)
    ? payload.stderr.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  return [
    {
      tool_call_id: topLevelToolCallId,
      status: topLevelStatus,
      tool_return: normalizeToolReturnValue(payload.tool_return),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
    },
  ];
}

function normalizeToolReturnWireMessage(
  chunk: Record<string, unknown>,
): Record<string, unknown> | null {
  if (chunk.message_type !== "tool_return_message") {
    return chunk;
  }

  const canonicalToolReturns = extractCanonicalToolReturnsFromWire(chunk);
  if (canonicalToolReturns.length === 0) {
    return null;
  }

  const {
    tool_call_id: _toolCallId,
    status: _status,
    tool_return: _toolReturn,
    stdout: _stdout,
    stderr: _stderr,
    ...rest
  } = chunk;

  return {
    ...rest,
    message_type: "tool_return_message",
    tool_returns: canonicalToolReturns,
  };
}

function extractInterruptToolReturns(
  approvals: ApprovalResult[] | null,
): InterruptToolReturn[] {
  if (!approvals || approvals.length === 0) {
    return [];
  }

  return approvals.flatMap((approval): InterruptToolReturn[] => {
    if (!approval || typeof approval !== "object") {
      return [];
    }

    if ("type" in approval && approval.type === "tool") {
      const toolCallId =
        "tool_call_id" in approval && typeof approval.tool_call_id === "string"
          ? approval.tool_call_id
          : null;
      if (!toolCallId) {
        return [];
      }
      const status =
        "status" in approval && approval.status === "success"
          ? "success"
          : "error";
      const stdout =
        "stdout" in approval && Array.isArray(approval.stdout)
          ? approval.stdout.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : undefined;
      const stderr =
        "stderr" in approval && Array.isArray(approval.stderr)
          ? approval.stderr.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : undefined;

      return [
        {
          tool_call_id: toolCallId,
          status,
          tool_return:
            "tool_return" in approval
              ? normalizeToolReturnValue(approval.tool_return)
              : "",
          ...(stdout ? { stdout } : {}),
          ...(stderr ? { stderr } : {}),
        },
      ];
    }

    if ("type" in approval && approval.type === "approval") {
      const toolCallId =
        "tool_call_id" in approval && typeof approval.tool_call_id === "string"
          ? approval.tool_call_id
          : null;
      if (!toolCallId) {
        return [];
      }
      const reason =
        "reason" in approval && typeof approval.reason === "string"
          ? approval.reason
          : "User interrupted the stream";
      return [
        {
          tool_call_id: toolCallId,
          status: "error",
          tool_return: reason,
        },
      ];
    }

    return [];
  });
}

function emitInterruptToolReturnMessage(
  socket: WebSocket,
  runtime: ListenerRuntime,
  approvals: ApprovalResult[] | null,
  runId?: string | null,
  uuidPrefix: string = "interrupt-tool-return",
): void {
  const toolReturns = extractInterruptToolReturns(approvals);
  if (toolReturns.length === 0) {
    return;
  }

  const resolvedRunId = runId ?? runtime.activeRunId ?? undefined;
  for (const toolReturn of toolReturns) {
    emitCanonicalMessageDelta(
      socket,
      runtime,
      {
        type: "message",
        message_type: "tool_return_message",
        id: `message-${uuidPrefix}-${crypto.randomUUID()}`,
        date: new Date().toISOString(),
        run_id: resolvedRunId,
        status: toolReturn.status,
        tool_call_id: toolReturn.tool_call_id,
        tool_return: toolReturn.tool_return,
        tool_returns: [
          {
            tool_call_id: toolReturn.tool_call_id,
            status: toolReturn.status,
            tool_return: toolReturn.tool_return,
            ...(toolReturn.stdout ? { stdout: toolReturn.stdout } : {}),
            ...(toolReturn.stderr ? { stderr: toolReturn.stderr } : {}),
          },
        ],
      },
      {
        agent_id: runtime.activeAgentId ?? undefined,
        conversation_id: runtime.activeConversationId ?? undefined,
      },
    );
  }
}

function emitToolExecutionStartedEvents(
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    toolCallIds: string[];
    runId?: string | null;
    agentId?: string;
    conversationId?: string;
  },
): void {
  for (const toolCallId of params.toolCallIds) {
    const delta: ClientToolStartMessage = {
      ...createLifecycleMessageBase("client_tool_start", params.runId),
      tool_call_id: toolCallId,
    };
    emitCanonicalMessageDelta(socket, runtime, delta, {
      agent_id: params.agentId,
      conversation_id: params.conversationId,
    });
  }
}

function emitToolExecutionFinishedEvents(
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    approvals: ApprovalResult[] | null;
    runId?: string | null;
    agentId?: string;
    conversationId?: string;
  },
): void {
  const toolReturns = extractInterruptToolReturns(params.approvals);
  for (const toolReturn of toolReturns) {
    const delta: ClientToolEndMessage = {
      ...createLifecycleMessageBase("client_tool_end", params.runId),
      tool_call_id: toolReturn.tool_call_id,
      status: toolReturn.status,
    };
    emitCanonicalMessageDelta(socket, runtime, delta, {
      agent_id: params.agentId,
      conversation_id: params.conversationId,
    });
  }
}

function getInterruptApprovalsForEmission(
  runtime: ListenerRuntime,
  params: {
    lastExecutionResults: ApprovalResult[] | null;
    agentId: string;
    conversationId: string;
  },
): ApprovalResult[] | null {
  if (params.lastExecutionResults && params.lastExecutionResults.length > 0) {
    return params.lastExecutionResults;
  }
  const context = runtime.pendingInterruptedContext;
  if (
    !context ||
    context.agentId !== params.agentId ||
    context.conversationId !== params.conversationId ||
    context.continuationEpoch !== runtime.continuationEpoch
  ) {
    return null;
  }
  if (
    !runtime.pendingInterruptedResults ||
    runtime.pendingInterruptedResults.length === 0
  ) {
    return null;
  }
  return runtime.pendingInterruptedResults;
}

/**
 * Populate the interrupt queue on the runtime after a cancel.
 * Returns true if the queue was populated, false if skipped (idempotent).
 *
 * Path A: execution completed before cancel → queue actual results.
 * Path B: no execution yet → synthesize denial results from stable ID sources.
 */
function populateInterruptQueue(
  runtime: ListenerRuntime,
  input: InterruptPopulateInput,
): boolean {
  // Idempotency: preserve first cancel's results if already populated.
  const shouldPopulate =
    !runtime.pendingInterruptedResults ||
    runtime.pendingInterruptedResults.length === 0 ||
    !runtime.pendingInterruptedContext;

  if (!shouldPopulate) return false;

  if (input.lastExecutionResults && input.lastExecutionResults.length > 0) {
    // Path A: execution happened before cancel — queue actual results
    // Guard parity: interrupted tool returns must persist as status=error.
    runtime.pendingInterruptedResults = normalizeInterruptedApprovalsForQueue(
      input.lastExecutionResults,
      input.lastExecutingToolCallIds,
    );
    runtime.pendingInterruptedContext = {
      agentId: input.agentId,
      conversationId: input.conversationId,
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = [...input.lastExecutingToolCallIds];
    return true;
  }

  // Path A.5: execution was in-flight (approved tools started) but no
  // terminal results were captured before cancel. Match App/headless parity by
  // queuing explicit tool errors, not synthetic approval denials.
  if (input.lastExecutingToolCallIds.length > 0) {
    runtime.pendingInterruptedResults = input.lastExecutingToolCallIds.map(
      (toolCallId) => ({
        type: "tool" as const,
        tool_call_id: toolCallId,
        tool_return: INTERRUPTED_BY_USER,
        status: "error" as const,
      }),
    );
    runtime.pendingInterruptedContext = {
      agentId: input.agentId,
      conversationId: input.conversationId,
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = [...input.lastExecutingToolCallIds];
    return true;
  }

  // Path B: no execution — synthesize denial results from stable ID sources.
  const batchToolCallIds = [...runtime.pendingApprovalBatchByToolCallId.keys()];
  const pendingIds =
    batchToolCallIds.length > 0
      ? batchToolCallIds
      : input.lastNeedsUserInputToolCallIds;

  if (pendingIds.length > 0) {
    runtime.pendingInterruptedResults = pendingIds.map((toolCallId) => ({
      type: "approval" as const,
      tool_call_id: toolCallId,
      approve: false,
      reason: "User interrupted the stream",
    }));
    runtime.pendingInterruptedContext = {
      agentId: input.agentId,
      conversationId: input.conversationId,
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = null;
    return true;
  }

  if (isDebugEnabled()) {
    console.warn(
      "[Listen] Cancel during approval loop but no tool_call_ids available " +
        "for interrupted queue — next turn may hit pre-stream conflict. " +
        `batchMap=${runtime.pendingApprovalBatchByToolCallId.size}, ` +
        `lastNeedsUserInput=${input.lastNeedsUserInputToolCallIds.length}`,
    );
  }
  return false;
}

/**
 * Consume queued interrupted results and return an ApprovalCreate to prepend,
 * or null if nothing to consume. Always clears the queue atomically.
 *
 * This is the SOLE consumption point — called at the top of handleIncomingMessage.
 */
function consumeInterruptQueue(
  runtime: ListenerRuntime,
  agentId: string,
  conversationId: string,
): {
  approvalMessage: { type: "approval"; approvals: ApprovalResult[] };
  interruptedToolCallIds: string[];
} | null {
  if (
    !runtime.pendingInterruptedResults ||
    runtime.pendingInterruptedResults.length === 0
  ) {
    return null;
  }

  const ctx = runtime.pendingInterruptedContext;
  let result: {
    approvalMessage: { type: "approval"; approvals: ApprovalResult[] };
    interruptedToolCallIds: string[];
  } | null = null;

  if (
    ctx &&
    ctx.agentId === agentId &&
    ctx.conversationId === conversationId &&
    ctx.continuationEpoch === runtime.continuationEpoch
  ) {
    result = {
      approvalMessage: {
        type: "approval",
        approvals: runtime.pendingInterruptedResults,
      },
      interruptedToolCallIds: runtime.pendingInterruptedToolCallIds
        ? [...runtime.pendingInterruptedToolCallIds]
        : [],
    };
  }

  const queuedToolCallIds = collectApprovalResultToolCallIds(
    runtime.pendingInterruptedResults,
  );

  // Atomic clear — always, regardless of context match.
  // Stale results for wrong context are discarded, not retried.
  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  for (const toolCallId of queuedToolCallIds) {
    runtime.pendingApprovalBatchByToolCallId.delete(toolCallId);
  }

  return result;
}

function stashRecoveredApprovalInterrupts(
  runtime: ListenerRuntime,
  recovered: RecoveredApprovalState,
): boolean {
  const approvals = [...recovered.approvalsByRequestId.values()].map(
    (entry) => entry.approval,
  );
  if (approvals.length === 0) {
    clearRecoveredApprovalState(runtime);
    return false;
  }

  runtime.pendingInterruptedResults = approvals.map((approval) => ({
    type: "approval" as const,
    tool_call_id: approval.toolCallId,
    approve: false,
    reason: "User interrupted the stream",
  }));
  runtime.pendingInterruptedContext = {
    agentId: recovered.agentId,
    conversationId: recovered.conversationId,
    continuationEpoch: runtime.continuationEpoch,
  };
  runtime.pendingInterruptedToolCallIds = null;
  clearRecoveredApprovalState(runtime);
  return true;
}

/**
 * Attempt to resolve stale pending approvals by fetching them from the backend
 * and auto-denying. This is the Phase 3 bounded recovery mechanism — it does NOT
 * touch pendingInterruptedResults (that's exclusively owned by handleIncomingMessage).
 */
async function resolveStaleApprovals(
  runtime: ListenerRuntime,
  socket: WebSocket,
  abortSignal: AbortSignal,
): Promise<Awaited<ReturnType<typeof drainStreamWithResume>> | null> {
  if (!runtime.activeAgentId) return null;

  const client = await getClient();
  let agent: Awaited<ReturnType<typeof client.agents.retrieve>>;
  try {
    agent = await client.agents.retrieve(runtime.activeAgentId);
  } catch (err) {
    // 404 = agent deleted, 422 = invalid ID — both mean nothing to recover
    if (err instanceof APIError && (err.status === 404 || err.status === 422)) {
      return null;
    }
    throw err;
  }
  const requestedConversationId =
    runtime.activeConversationId && runtime.activeConversationId !== "default"
      ? runtime.activeConversationId
      : undefined;

  let resumeData: Awaited<ReturnType<typeof getResumeData>>;
  try {
    resumeData = await getResumeData(client, agent, requestedConversationId, {
      includeMessageHistory: false,
    });
  } catch (err) {
    // getResumeData rethrows 404/422 for conversations — treat as no approvals
    if (err instanceof APIError && (err.status === 404 || err.status === 422)) {
      return null;
    }
    throw err;
  }

  let pendingApprovals = resumeData.pendingApprovals || [];
  if (pendingApprovals.length === 0) return null;
  if (abortSignal.aborted) throw new Error("Cancelled");

  const recoveryConversationId = runtime.activeConversationId || "default";
  const recoveryWorkingDirectory =
    runtime.activeWorkingDirectory ??
    getConversationWorkingDirectory(
      runtime,
      runtime.activeAgentId,
      recoveryConversationId,
    );
  const scope = {
    agent_id: runtime.activeAgentId,
    conversation_id: recoveryConversationId,
  } as const;

  while (pendingApprovals.length > 0) {
    const recoveryBatchId = resolveRecoveryBatchId(runtime, pendingApprovals);
    if (!recoveryBatchId) {
      throw new Error(
        "Ambiguous pending approval batch mapping during recovery",
      );
    }
    rememberPendingApprovalBatchIds(runtime, pendingApprovals, recoveryBatchId);

    const { autoAllowed, autoDenied, needsUserInput } = await classifyApprovals(
      pendingApprovals,
      {
        alwaysRequiresUserInput: isInteractiveApprovalTool,
        requireArgsForAutoApprove: true,
        missingNameReason: "Tool call incomplete - missing name",
        workingDirectory: recoveryWorkingDirectory,
      },
    );

    const decisions: ApprovalDecision[] = [
      ...autoAllowed.map((ac) => ({
        type: "approve" as const,
        approval: ac.approval,
      })),
      ...autoDenied.map((ac) => ({
        type: "deny" as const,
        approval: ac.approval,
        reason: ac.denyReason || ac.permission.reason || "Permission denied",
      })),
    ];

    if (needsUserInput.length > 0) {
      runtime.lastStopReason = "requires_approval";
      setLoopStatus(runtime, "WAITING_ON_APPROVAL", scope);
      emitRuntimeStateUpdates(runtime, scope);

      for (const ac of needsUserInput) {
        if (abortSignal.aborted) throw new Error("Cancelled");

        const requestId = `perm-${ac.approval.toolCallId}`;
        const diffs = await computeDiffPreviews(
          ac.approval.toolName,
          ac.parsedArgs,
          recoveryWorkingDirectory,
        );
        const controlRequest: ControlRequest = {
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "can_use_tool",
            tool_name: ac.approval.toolName,
            input: ac.parsedArgs,
            tool_call_id: ac.approval.toolCallId,
            permission_suggestions: [],
            blocked_path: null,
            ...(diffs.length > 0 ? { diffs } : {}),
          },
          agent_id: runtime.activeAgentId,
          conversation_id: recoveryConversationId,
        };

        const responseBody = await requestApprovalOverWS(
          runtime,
          socket,
          requestId,
          controlRequest,
        );

        if ("decision" in responseBody) {
          const response = responseBody.decision as ApprovalResponseDecision;
          if (response.behavior === "allow") {
            decisions.push({
              type: "approve",
              approval: response.updated_input
                ? {
                    ...ac.approval,
                    toolArgs: JSON.stringify(response.updated_input),
                  }
                : ac.approval,
            });
          } else {
            decisions.push({
              type: "deny",
              approval: ac.approval,
              reason: response.message || "Denied via WebSocket",
            });
          }
        } else {
          decisions.push({
            type: "deny",
            approval: ac.approval,
            reason: responseBody.error,
          });
        }
      }
    }

    if (decisions.length === 0) {
      clearPendingApprovalBatchIds(runtime, pendingApprovals);
      return null;
    }

    const approvedToolCallIds = decisions
      .filter(
        (
          decision,
        ): decision is Extract<ApprovalDecision, { type: "approve" }> =>
          decision.type === "approve",
      )
      .map((decision) => decision.approval.toolCallId);

    runtime.activeExecutingToolCallIds = [...approvedToolCallIds];
    setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", scope);
    emitRuntimeStateUpdates(runtime, scope);
    emitToolExecutionStartedEvents(socket, runtime, {
      toolCallIds: approvedToolCallIds,
      runId: runtime.activeRunId ?? undefined,
      agentId: runtime.activeAgentId,
      conversationId: recoveryConversationId,
    });

    try {
      const approvalResults = await executeApprovalBatch(decisions, undefined, {
        abortSignal,
        workingDirectory: recoveryWorkingDirectory,
      });
      emitToolExecutionFinishedEvents(socket, runtime, {
        approvals: approvalResults,
        runId: runtime.activeRunId ?? undefined,
        agentId: runtime.activeAgentId,
        conversationId: recoveryConversationId,
      });
      emitInterruptToolReturnMessage(
        socket,
        runtime,
        approvalResults,
        runtime.activeRunId ?? undefined,
        "tool-return",
      );

      const recoveryStream = await sendApprovalContinuationWithRetry(
        recoveryConversationId,
        [{ type: "approval", approvals: approvalResults }],
        {
          agentId: runtime.activeAgentId,
          streamTokens: true,
          background: true,
          workingDirectory: recoveryWorkingDirectory,
        },
        socket,
        runtime,
        abortSignal,
        { allowApprovalRecovery: false },
      );
      if (!recoveryStream) {
        throw new Error(
          "Approval recovery send resolved without a continuation stream",
        );
      }

      const drainResult = await drainRecoveryStreamWithEmission(
        recoveryStream as Stream<LettaStreamingResponse>,
        socket,
        runtime,
        {
          agentId: runtime.activeAgentId,
          conversationId: recoveryConversationId,
          abortSignal,
        },
      );

      if (drainResult.stopReason === "error") {
        throw new Error("Pre-stream approval recovery drain ended with error");
      }
      clearPendingApprovalBatchIds(
        runtime,
        decisions.map((decision) => decision.approval),
      );
      if (drainResult.stopReason !== "requires_approval") {
        return drainResult;
      }
      pendingApprovals = drainResult.approvals || [];
    } finally {
      runtime.activeExecutingToolCallIds = [];
    }
  }

  return null;
}

function parseApprovalInput(toolArgs: string): Record<string, unknown> {
  if (!toolArgs) return {};
  try {
    const parsed = JSON.parse(toolArgs) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function recoverApprovalStateForSync(
  runtime: ListenerRuntime,
  scope: RuntimeScope,
): Promise<void> {
  const sameActiveScope =
    runtime.activeAgentId === scope.agent_id &&
    resolveScopedConversationId(runtime, {
      conversation_id: runtime.activeConversationId,
    }) === scope.conversation_id;

  if (
    sameActiveScope &&
    (runtime.isProcessing || runtime.loopStatus !== "WAITING_ON_INPUT")
  ) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  if (runtime.pendingApprovalResolvers.size > 0 && sameActiveScope) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  const client = await getClient();
  let agent: Awaited<ReturnType<typeof client.agents.retrieve>>;
  try {
    agent = await client.agents.retrieve(scope.agent_id);
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.status === 404 || error.status === 422)
    ) {
      clearRecoveredApprovalState(runtime);
      return;
    }
    throw error;
  }

  let resumeData: Awaited<ReturnType<typeof getResumeData>>;
  try {
    resumeData = await getResumeData(client, agent, scope.conversation_id, {
      includeMessageHistory: false,
    });
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.status === 404 || error.status === 422)
    ) {
      clearRecoveredApprovalState(runtime);
      return;
    }
    throw error;
  }

  const pendingApprovals = resumeData.pendingApprovals ?? [];
  if (pendingApprovals.length === 0) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  const approvalsByRequestId = new Map<string, RecoveredPendingApproval>();
  await Promise.all(
    pendingApprovals.map(async (approval) => {
      const requestId = `perm-${approval.toolCallId}`;
      const input = parseApprovalInput(approval.toolArgs);
      const diffs = await computeDiffPreviews(
        approval.toolName,
        input,
        getConversationWorkingDirectory(
          runtime,
          scope.agent_id,
          scope.conversation_id,
        ),
      );

      approvalsByRequestId.set(requestId, {
        approval,
        controlRequest: {
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "can_use_tool",
            tool_name: approval.toolName,
            input,
            tool_call_id: approval.toolCallId,
            permission_suggestions: [],
            blocked_path: null,
            ...(diffs.length > 0 ? { diffs } : {}),
          },
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
        },
      });
    }),
  );

  runtime.recoveredApprovalState = {
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    approvalsByRequestId,
    pendingRequestIds: new Set(approvalsByRequestId.keys()),
    responsesByRequestId: new Map(),
  };
}

async function resolveRecoveredApprovalResponse(
  runtime: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
  response: ApprovalResponseBody,
): Promise<boolean> {
  const requestId = response.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return false;
  }

  const recovered = runtime.recoveredApprovalState;
  if (!recovered || !recovered.approvalsByRequestId.has(requestId)) {
    return false;
  }

  recovered.responsesByRequestId.set(requestId, response);
  recovered.pendingRequestIds.delete(requestId);

  if (recovered.pendingRequestIds.size > 0) {
    emitRuntimeStateUpdates(runtime, {
      agent_id: recovered.agentId,
      conversation_id: recovered.conversationId,
    });
    return true;
  }

  const decisions: ApprovalDecision[] = [];
  for (const [id, entry] of recovered.approvalsByRequestId) {
    const approvalResponse = recovered.responsesByRequestId.get(id);
    if (!approvalResponse) {
      continue;
    }

    if ("decision" in approvalResponse) {
      const decision = approvalResponse.decision as ApprovalResponseDecision;
      if (decision.behavior === "allow") {
        decisions.push({
          type: "approve",
          approval: decision.updated_input
            ? {
                ...entry.approval,
                toolArgs: JSON.stringify(decision.updated_input),
              }
            : entry.approval,
        });
      } else {
        decisions.push({
          type: "deny",
          approval: entry.approval,
          reason: decision.message || "Denied via WebSocket",
        });
      }
    } else {
      decisions.push({
        type: "deny",
        approval: entry.approval,
        reason: approvalResponse.error,
      });
    }
  }

  const scope = {
    agent_id: recovered.agentId,
    conversation_id: recovered.conversationId,
  } as const;
  const approvedToolCallIds = decisions
    .filter(
      (decision): decision is Extract<ApprovalDecision, { type: "approve" }> =>
        decision.type === "approve",
    )
    .map((decision) => decision.approval.toolCallId);

  // Mirror the normal approval loop behavior:
  // the approval is resolved immediately from the UI's perspective, then the
  // approved tool transitions into execution / processing state.
  recovered.pendingRequestIds.clear();
  emitRuntimeStateUpdates(runtime, scope);

  runtime.isProcessing = true;
  runtime.activeAgentId = recovered.agentId;
  runtime.activeConversationId = recovered.conversationId;
  runtime.activeWorkingDirectory = getConversationWorkingDirectory(
    runtime,
    recovered.agentId,
    recovered.conversationId,
  );
  runtime.activeExecutingToolCallIds = [...approvedToolCallIds];
  setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", scope);
  emitRuntimeStateUpdates(runtime, scope);
  emitToolExecutionStartedEvents(socket, runtime, {
    toolCallIds: approvedToolCallIds,
    runId: runtime.activeRunId ?? undefined,
    agentId: recovered.agentId,
    conversationId: recovered.conversationId,
  });
  const recoveryAbortController = new AbortController();
  runtime.activeAbortController = recoveryAbortController;
  try {
    const approvalResults = await executeApprovalBatch(decisions, undefined, {
      abortSignal: recoveryAbortController.signal,
      workingDirectory: getConversationWorkingDirectory(
        runtime,
        recovered.agentId,
        recovered.conversationId,
      ),
    });

    emitToolExecutionFinishedEvents(socket, runtime, {
      approvals: approvalResults,
      runId: runtime.activeRunId ?? undefined,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
    });
    emitInterruptToolReturnMessage(
      socket,
      runtime,
      approvalResults,
      runtime.activeRunId ?? undefined,
      "tool-return",
    );

    runtime.activeAbortController = null;
    setLoopStatus(runtime, "SENDING_API_REQUEST", scope);
    emitRuntimeStateUpdates(runtime, scope);

    await handleIncomingMessage(
      {
        type: "message",
        agentId: recovered.agentId,
        conversationId: recovered.conversationId,
        messages: [
          {
            type: "approval",
            approvals: approvalResults,
          },
        ],
      },
      socket,
      runtime,
      opts.onStatusChange,
      opts.connectionId,
      `batch-recovered-${crypto.randomUUID()}`,
    );

    clearRecoveredApprovalState(runtime);
    return true;
  } catch (error) {
    recovered.pendingRequestIds = new Set(
      recovered.approvalsByRequestId.keys(),
    );
    recovered.responsesByRequestId.clear();
    runtime.activeAbortController = null;
    runtime.isProcessing = false;
    runtime.activeExecutingToolCallIds = [];
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, {
      agent_id: recovered.agentId,
      conversation_id: recovered.conversationId,
    });
    throw error;
  }
}

/**
 * Wrap sendMessageStream with pre-stream error handling (retry/recovery).
 * Mirrors headless bidirectional mode's pre-stream error handling.
 */
async function sendMessageStreamWithRetry(
  conversationId: string,
  messages: Parameters<typeof sendMessageStream>[1],
  opts: Parameters<typeof sendMessageStream>[2],
  socket: WebSocket,
  runtime: ListenerRuntime,
  abortSignal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof sendMessageStream>>> {
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  let preStreamRecoveryAttempts = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 3;
  const requestStartedAtMs = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    runtime.isRecoveringApprovals = false;
    setLoopStatus(runtime, "WAITING_FOR_API_RESPONSE", {
      agent_id: runtime.activeAgentId,
      conversation_id: conversationId,
    });

    try {
      return await sendMessageStream(
        conversationId,
        messages,
        opts,
        abortSignal
          ? { maxRetries: 0, signal: abortSignal }
          : { maxRetries: 0 },
      );
    } catch (preStreamError) {
      if (abortSignal?.aborted) {
        throw new Error("Cancelled by user");
      }

      const errorDetail = extractConflictDetail(preStreamError);
      const action = getPreStreamErrorAction(
        errorDetail,
        conversationBusyRetries,
        MAX_CONVERSATION_BUSY_RETRIES,
        {
          status:
            preStreamError instanceof APIError
              ? preStreamError.status
              : undefined,
          transientRetries,
          maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
        },
      );

      const approvalConflictDetected =
        action === "resolve_approval_pending" ||
        isApprovalToolCallDesyncError(errorDetail);

      if (approvalConflictDetected) {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.activeAgentId,
          conversation_id: conversationId,
        });
        // Abort check first — don't let recovery mask a user cancel
        if (abortSignal?.aborted) throw new Error("Cancelled by user");

        // Attempt bounded recovery: fetch pending approvals and auto-deny them.
        // This does NOT touch pendingInterruptedResults (sole owner: handleIncomingMessage).
        if (
          abortSignal &&
          preStreamRecoveryAttempts < MAX_PRE_STREAM_RECOVERY
        ) {
          preStreamRecoveryAttempts++;
          try {
            await resolveStaleApprovals(runtime, socket, abortSignal);
            continue; // Retry send after resolving
          } catch (_recoveryError) {
            if (abortSignal.aborted) throw new Error("Cancelled by user");
            // Recovery failed — fall through to structured error
          }
        }

        // Unrecoverable — emit structured error instead of blind rethrow
        const detail = await fetchRunErrorDetail(runtime.activeRunId);
        throw new Error(
          detail ||
            `Pre-stream approval conflict after ${preStreamRecoveryAttempts} recovery attempts`,
        );
      }

      if (action === "retry_transient") {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.activeAgentId,
          conversation_id: conversationId,
        });
        const attempt = transientRetries + 1;
        const retryAfterMs =
          preStreamError instanceof APIError
            ? parseRetryAfterHeaderMs(
                preStreamError.headers?.get("retry-after"),
              )
            : null;
        const delayMs = getRetryDelayMs({
          category: "transient_provider",
          attempt,
          detail: errorDetail,
          retryAfterMs,
        });
        transientRetries = attempt;

        const retryMessage = getRetryStatusMessage(errorDetail);
        if (retryMessage) {
          emitRetryDelta(socket, runtime, {
            message: retryMessage,
            reason: "error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            agentId: runtime.activeAgentId ?? undefined,
            conversationId,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      if (action === "retry_conversation_busy") {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.activeAgentId,
          conversation_id: conversationId,
        });
        try {
          const client = await getClient();
          const discoveredRunId = await discoverFallbackRunIdWithTimeout(
            client,
            {
              conversationId,
              resolvedConversationId: conversationId,
              agentId: runtime.activeAgentId,
              requestStartedAtMs,
            },
          );

          if (discoveredRunId) {
            if (abortSignal?.aborted) {
              throw new Error("Cancelled by user");
            }
            return await client.runs.messages.stream(discoveredRunId, {
              starting_after: 0,
              batch_size: 1000,
            });
          }
        } catch (resumeError) {
          if (abortSignal?.aborted) {
            throw new Error("Cancelled by user");
          }
          if (process.env.DEBUG) {
            console.warn(
              "[Listen] Pre-stream resume failed, falling back to wait/retry:",
              resumeError instanceof Error
                ? resumeError.message
                : String(resumeError),
            );
          }
        }

        const attempt = conversationBusyRetries + 1;
        const delayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt,
        });
        conversationBusyRetries = attempt;

        emitRetryDelta(socket, runtime, {
          message: "Conversation is busy, waiting and retrying…",
          reason: "error",
          attempt,
          maxAttempts: MAX_CONVERSATION_BUSY_RETRIES,
          delayMs,
          agentId: runtime.activeAgentId ?? undefined,
          conversationId,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      // rethrow unrecoverable errors
      throw preStreamError;
    }
  }
}

async function sendApprovalContinuationWithRetry(
  conversationId: string,
  messages: Parameters<typeof sendMessageStream>[1],
  opts: Parameters<typeof sendMessageStream>[2],
  socket: WebSocket,
  runtime: ListenerRuntime,
  abortSignal?: AbortSignal,
  retryOptions: {
    allowApprovalRecovery?: boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof sendMessageStream>> | null> {
  const allowApprovalRecovery = retryOptions.allowApprovalRecovery ?? true;
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  let preStreamRecoveryAttempts = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 3;
  const requestStartedAtMs = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    runtime.isRecoveringApprovals = false;
    setLoopStatus(runtime, "WAITING_FOR_API_RESPONSE", {
      agent_id: runtime.activeAgentId,
      conversation_id: conversationId,
    });

    try {
      return await sendMessageStream(
        conversationId,
        messages,
        opts,
        abortSignal
          ? { maxRetries: 0, signal: abortSignal }
          : { maxRetries: 0 },
      );
    } catch (preStreamError) {
      if (abortSignal?.aborted) {
        throw new Error("Cancelled by user");
      }

      const errorDetail = extractConflictDetail(preStreamError);
      const action = getPreStreamErrorAction(
        errorDetail,
        conversationBusyRetries,
        MAX_CONVERSATION_BUSY_RETRIES,
        {
          status:
            preStreamError instanceof APIError
              ? preStreamError.status
              : undefined,
          transientRetries,
          maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
        },
      );

      const approvalConflictDetected =
        action === "resolve_approval_pending" ||
        isApprovalToolCallDesyncError(errorDetail);

      if (approvalConflictDetected) {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.activeAgentId,
          conversation_id: conversationId,
        });

        if (
          allowApprovalRecovery &&
          abortSignal &&
          preStreamRecoveryAttempts < MAX_PRE_STREAM_RECOVERY
        ) {
          preStreamRecoveryAttempts++;
          const drainResult = await resolveStaleApprovals(
            runtime,
            socket,
            abortSignal,
          );
          if (
            drainResult &&
            getApprovalContinuationRecoveryDisposition(drainResult) ===
              "handled"
          ) {
            finalizeHandledRecoveryTurn(runtime, socket, {
              drainResult,
              agentId: runtime.activeAgentId,
              conversationId,
            });
            return null;
          }
          continue;
        }

        const detail = await fetchRunErrorDetail(runtime.activeRunId);
        throw new Error(
          detail ||
            `Approval continuation conflict after ${preStreamRecoveryAttempts} recovery attempts`,
        );
      }

      if (action === "retry_transient") {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.activeAgentId,
          conversation_id: conversationId,
        });
        const attempt = transientRetries + 1;
        const retryAfterMs =
          preStreamError instanceof APIError
            ? parseRetryAfterHeaderMs(
                preStreamError.headers?.get("retry-after"),
              )
            : null;
        const delayMs = getRetryDelayMs({
          category: "transient_provider",
          attempt,
          detail: errorDetail,
          retryAfterMs,
        });
        transientRetries = attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      if (action === "retry_conversation_busy") {
        conversationBusyRetries += 1;
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.activeAgentId,
          conversation_id: conversationId,
        });

        try {
          const client = await getClient();
          const discoveredRunId = await discoverFallbackRunIdWithTimeout(
            client,
            {
              conversationId,
              resolvedConversationId: conversationId,
              agentId: runtime.activeAgentId,
              requestStartedAtMs,
            },
          );

          if (discoveredRunId) {
            if (abortSignal?.aborted) {
              throw new Error("Cancelled by user");
            }
            return await client.runs.messages.stream(discoveredRunId, {
              starting_after: 0,
              batch_size: 1000,
            });
          }
        } catch (resumeError) {
          if (abortSignal?.aborted) {
            throw new Error("Cancelled by user");
          }
          if (process.env.DEBUG) {
            console.warn(
              "[Listen] Approval continuation pre-stream resume failed, falling back to wait/retry:",
              resumeError instanceof Error
                ? resumeError.message
                : String(resumeError),
            );
          }
        }

        const retryDelayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt: conversationBusyRetries,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      throw preStreamError;
    }
  }
}

export function resolvePendingApprovalResolver(
  runtime: ListenerRuntime,
  response: ApprovalResponseBody,
): boolean {
  const requestId = response.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return false;
  }

  const pending = runtime.pendingApprovalResolvers.get(requestId);
  if (!pending) {
    return false;
  }

  runtime.pendingApprovalResolvers.delete(requestId);
  if (runtime.pendingApprovalResolvers.size === 0) {
    setLoopStatus(
      runtime,
      runtime.isProcessing ? "PROCESSING_API_RESPONSE" : "WAITING_ON_INPUT",
    );
  }
  pending.resolve(response);
  emitLoopStatusIfOpen(runtime);
  emitDeviceStatusIfOpen(runtime);
  return true;
}

export function rejectPendingApprovalResolvers(
  runtime: ListenerRuntime,
  reason: string,
): void {
  for (const [, pending] of runtime.pendingApprovalResolvers) {
    pending.reject(new Error(reason));
  }
  runtime.pendingApprovalResolvers.clear();
  setLoopStatus(
    runtime,
    runtime.isProcessing ? "PROCESSING_API_RESPONSE" : "WAITING_ON_INPUT",
  );
  emitLoopStatusIfOpen(runtime);
  emitDeviceStatusIfOpen(runtime);
}

export function requestApprovalOverWS(
  runtime: ListenerRuntime,
  socket: WebSocket,
  requestId: string,
  controlRequest: ControlRequest,
): Promise<ApprovalResponseBody> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket not open"));
  }

  return new Promise<ApprovalResponseBody>((resolve, reject) => {
    runtime.pendingApprovalResolvers.set(requestId, {
      resolve,
      reject,
      controlRequest,
    });
    setLoopStatus(runtime, "WAITING_ON_APPROVAL");
    emitLoopStatusIfOpen(runtime);
    emitDeviceStatusIfOpen(runtime);
  });
}

/**
 * Start the listener WebSocket client with automatic retry.
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Replace any existing runtime without stale callback leakage.
  if (activeRuntime) {
    stopRuntime(activeRuntime, true);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = opts.onWsEvent;
  runtime.connectionId = opts.connectionId;
  runtime.connectionName = opts.connectionName;
  activeRuntime = runtime;

  await connectWithRetry(runtime, opts);
}

/**
 * Connect to WebSocket with exponential backoff retry.
 */
async function connectWithRetry(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
  attempt: number = 0,
  startTime: number = Date.now(),
): Promise<void> {
  if (runtime !== activeRuntime || runtime.intentionallyClosed) {
    return;
  }

  const elapsedTime = Date.now() - startTime;

  if (attempt > 0) {
    if (elapsedTime >= MAX_RETRY_DURATION_MS) {
      opts.onError(new Error("Failed to connect after 5 minutes of retrying"));
      return;
    }

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    const maxAttempts = Math.ceil(
      Math.log2(MAX_RETRY_DURATION_MS / INITIAL_RETRY_DELAY_MS),
    );

    opts.onRetrying?.(attempt, maxAttempts, delay, opts.connectionId);

    await new Promise<void>((resolve) => {
      runtime.reconnectTimeout = setTimeout(resolve, delay);
    });

    runtime.reconnectTimeout = null;
    if (runtime !== activeRuntime || runtime.intentionallyClosed) {
      return;
    }
  }

  clearRuntimeTimers(runtime);

  if (attempt === 0) {
    await loadTools();
  }

  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY");
  }

  const url = new URL(opts.wsUrl);
  url.searchParams.set("deviceId", opts.deviceId);
  url.searchParams.set("connectionName", opts.connectionName);

  const socket = new WebSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  runtime.socket = socket;

  socket.on("open", () => {
    if (runtime !== activeRuntime || runtime.intentionallyClosed) {
      return;
    }

    safeEmitWsEvent("recv", "lifecycle", { type: "_ws_open" });
    runtime.hasSuccessfulConnection = true;
    opts.onConnected(opts.connectionId);

    emitDeviceStatusUpdate(socket, runtime);
    emitLoopStatusUpdate(socket, runtime);

    runtime.heartbeatInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);
  });

  socket.on("message", async (data: WebSocket.RawData) => {
    const raw = data.toString();
    const parsed = parseServerMessage(data);
    if (parsed) {
      safeEmitWsEvent("recv", "client", parsed);
    } else {
      // Log unparseable frames so protocol drift is visible in debug mode
      safeEmitWsEvent("recv", "lifecycle", {
        type: "_ws_unparseable",
        raw,
      });
    }
    if (isDebugEnabled()) {
      console.log(
        `[Listen] Received message: ${JSON.stringify(parsed, null, 2)}`,
      );
    }

    if (!parsed) {
      return;
    }

    if (parsed.type === "__invalid_input") {
      emitLoopErrorDelta(socket, runtime, {
        message: parsed.reason,
        stopReason: "error",
        isTerminal: false,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      return;
    }

    if (parsed.type === "sync") {
      console.log(
        `[Listen V2] Received sync command for runtime=${parsed.runtime.agent_id}/${parsed.runtime.conversation_id}`,
      );
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        console.log(`[Listen V2] Dropping sync: runtime mismatch or closed`);
        return;
      }
      await recoverApprovalStateForSync(runtime, parsed.runtime);
      emitStateSync(socket, runtime, parsed.runtime);
      return;
    }

    if (parsed.type === "input") {
      console.log(
        `[Listen V2] Received input command, kind=${parsed.payload?.kind}`,
      );
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        console.log(`[Listen V2] Dropping input: runtime mismatch or closed`);
        return;
      }

      if (parsed.payload.kind === "approval_response") {
        if (resolvePendingApprovalResolver(runtime, parsed.payload)) {
          scheduleQueuePump(runtime, socket, opts);
          return;
        }
        if (
          await resolveRecoveredApprovalResponse(
            runtime,
            socket,
            opts,
            parsed.payload,
          )
        ) {
          scheduleQueuePump(runtime, socket, opts);
        }
        return;
      }

      const inputPayload = parsed.payload;
      if (inputPayload.kind !== "create_message") {
        emitLoopErrorDelta(socket, runtime, {
          message: `Unsupported input payload kind: ${String((inputPayload as { kind?: unknown }).kind)}`,
          stopReason: "error",
          isTerminal: false,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
        return;
      }

      const incoming: IncomingMessage = {
        type: "message",
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
        messages: inputPayload.messages,
      };
      const hasApprovalPayload = incoming.messages.some(
        (payload): payload is ApprovalCreate =>
          "type" in payload && payload.type === "approval",
      );
      if (hasApprovalPayload) {
        emitLoopErrorDelta(socket, runtime, {
          message:
            "Protocol violation: approval payloads are not allowed in input.kind=create_message. Use input.kind=approval_response.",
          stopReason: "error",
          isTerminal: false,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
        return;
      }

      if (shouldQueueInboundMessage(incoming)) {
        const firstUserPayload = incoming.messages.find(
          (
            payload,
          ): payload is MessageCreate & { client_message_id?: string } =>
            "content" in payload,
        );
        if (firstUserPayload) {
          const enqueuedItem = runtime.queueRuntime.enqueue({
            kind: "message",
            source: "user",
            content: firstUserPayload.content,
            clientMessageId:
              firstUserPayload.client_message_id ??
              `cm-submit-${crypto.randomUUID()}`,
            agentId: parsed.runtime.agent_id,
            conversationId: parsed.runtime.conversation_id || "default",
          } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
          if (enqueuedItem) {
            runtime.queuedMessagesByItemId.set(enqueuedItem.id, incoming);
          }
        }
        scheduleQueuePump(runtime, socket, opts);
        return;
      }

      runtime.messageQueue = runtime.messageQueue
        .then(async () => {
          if (runtime !== activeRuntime || runtime.intentionallyClosed) {
            return;
          }
          opts.onStatusChange?.("receiving", opts.connectionId);
          await handleIncomingMessage(
            incoming,
            socket,
            runtime,
            opts.onStatusChange,
            opts.connectionId,
          );
          opts.onStatusChange?.("idle", opts.connectionId);
          scheduleQueuePump(runtime, socket, opts);
        })
        .catch((error: unknown) => {
          if (process.env.DEBUG) {
            console.error("[Listen] Error handling queued input:", error);
          }
          opts.onStatusChange?.("idle", opts.connectionId);
          scheduleQueuePump(runtime, socket, opts);
        });
      return;
    }

    if (parsed.type === "change_device_state") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }
      const scope = {
        agent_id:
          parsed.payload.agent_id ?? parsed.runtime.agent_id ?? undefined,
        conversation_id:
          parsed.payload.conversation_id ??
          parsed.runtime.conversation_id ??
          undefined,
      };
      const shouldTrackCommand =
        !runtime.isProcessing &&
        getPendingControlRequestCount(runtime, scope) === 0;
      if (shouldTrackCommand) {
        setLoopStatus(runtime, "EXECUTING_COMMAND", scope);
      }
      try {
        if (parsed.payload.mode) {
          handleModeChange(
            { mode: parsed.payload.mode },
            socket,
            runtime,
            scope,
          );
        }
        if (parsed.payload.cwd) {
          await handleCwdChange(
            {
              agentId: scope.agent_id ?? null,
              conversationId: scope.conversation_id ?? null,
              cwd: parsed.payload.cwd,
            },
            socket,
            runtime,
          );
        } else if (!parsed.payload.mode) {
          emitDeviceStatusUpdate(socket, runtime, scope);
        }
      } finally {
        if (shouldTrackCommand) {
          setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
        }
      }
      return;
    }

    if (parsed.type === "abort_message") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      const hasPendingApprovals =
        getPendingControlRequestCount(runtime, {
          agent_id: parsed.runtime.agent_id,
          conversation_id: parsed.runtime.conversation_id,
        }) > 0;
      const hasActiveTurn = runtime.isProcessing;

      if (!hasActiveTurn && !hasPendingApprovals) {
        return;
      }

      runtime.cancelRequested = true;
      // Eager interrupt capture parity with App/headless:
      // if tool execution is currently in-flight, queue explicit interrupted
      // tool results immediately at cancel time (before async catch paths).
      if (
        runtime.activeExecutingToolCallIds.length > 0 &&
        (!runtime.pendingInterruptedResults ||
          runtime.pendingInterruptedResults.length === 0)
      ) {
        runtime.pendingInterruptedResults =
          runtime.activeExecutingToolCallIds.map((toolCallId) => ({
            type: "tool",
            tool_call_id: toolCallId,
            tool_return: INTERRUPTED_BY_USER,
            status: "error",
          }));
        runtime.pendingInterruptedContext = {
          agentId: runtime.activeAgentId || "",
          conversationId: runtime.activeConversationId || "default",
          continuationEpoch: runtime.continuationEpoch,
        };
        runtime.pendingInterruptedToolCallIds = [
          ...runtime.activeExecutingToolCallIds,
        ];
      }
      if (
        runtime.activeAbortController &&
        !runtime.activeAbortController.signal.aborted
      ) {
        runtime.activeAbortController.abort();
      }
      const recoveredApprovalState = getRecoveredApprovalStateForScope(
        runtime,
        {
          agent_id: parsed.runtime.agent_id,
          conversation_id: parsed.runtime.conversation_id,
        },
      );
      if (recoveredApprovalState && !hasActiveTurn) {
        stashRecoveredApprovalInterrupts(runtime, recoveredApprovalState);
      }
      if (hasPendingApprovals) {
        rejectPendingApprovalResolvers(runtime, "Cancelled by user");
      }

      if (!hasActiveTurn && hasPendingApprovals) {
        emitInterruptedStatusDelta(socket, runtime, {
          runId: runtime.activeRunId,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
      }

      // Backend cancel parity with TUI (App.tsx:5932-5941).
      // Fire-and-forget — local cancel + queued results are the primary mechanism.
      const cancelConversationId = runtime.activeConversationId;
      const cancelAgentId = runtime.activeAgentId;
      if (cancelAgentId) {
        getClient()
          .then((client) => {
            const cancelId =
              cancelConversationId === "default" || !cancelConversationId
                ? cancelAgentId
                : cancelConversationId;
            return client.conversations.cancel(cancelId);
          })
          .catch(() => {
            // Fire-and-forget
          });
      }

      scheduleQueuePump(runtime, socket, opts);
      return;
    }
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (runtime !== activeRuntime) {
      return;
    }

    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_close",
      code,
      reason: reason.toString(),
    });

    // Single authoritative queue clear for all close paths
    // (intentional and unintentional). Must fire before early returns.
    runtime.queuedMessagesByItemId.clear();
    runtime.queueRuntime.clear("shutdown");

    if (isDebugEnabled()) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    clearRuntimeTimers(runtime);
    killAllTerminals();
    runtime.socket = null;
    rejectPendingApprovalResolvers(runtime, "WebSocket disconnected");

    if (runtime.intentionallyClosed) {
      opts.onDisconnected();
      return;
    }

    // 1008: Environment not found - need to re-register
    if (code === 1008) {
      if (isDebugEnabled()) {
        console.log("[Listen] Environment not found, re-registering...");
      }
      // Stop retry loop and signal that we need to re-register
      if (opts.onNeedsReregister) {
        opts.onNeedsReregister();
      } else {
        opts.onDisconnected();
      }
      return;
    }

    // If we had connected before, restart backoff from zero for this outage window.
    const nextAttempt = runtime.hasSuccessfulConnection ? 0 : attempt + 1;
    const nextStartTime = runtime.hasSuccessfulConnection
      ? Date.now()
      : startTime;
    runtime.hasSuccessfulConnection = false;

    connectWithRetry(runtime, opts, nextAttempt, nextStartTime).catch(
      (error) => {
        opts.onError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  socket.on("error", (error: Error) => {
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_error",
      message: error.message,
    });
    if (isDebugEnabled()) {
      console.error("[Listen] WebSocket error:", error);
    }
    // Error triggers close(), which handles retry logic.
  });
}

/**
 * Handle an incoming message from the cloud.
 */
async function handleIncomingMessage(
  msg: IncomingMessage,
  socket: WebSocket,
  runtime: ListenerRuntime,
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void,
  connectionId?: string,
  dequeuedBatchId: string = `batch-direct-${crypto.randomUUID()}`,
): Promise<void> {
  // Hoist identifiers and tracking state so they're available in catch for error-result
  const agentId = msg.agentId;
  const requestedConversationId = msg.conversationId || undefined;
  const conversationId = requestedConversationId ?? "default";
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  const turnWorkingDirectory = getConversationWorkingDirectory(
    runtime,
    normalizedAgentId,
    conversationId,
  );
  const msgRunIds: string[] = [];
  let postStopApprovalRecoveryRetries = 0;
  let llmApiErrorRetries = 0;
  let emptyResponseRetries = 0;
  let lastApprovalContinuationAccepted = false;

  // Track last approval-loop state for cancel-time queueing (Phase 1.2).
  // Hoisted before try so the cancel catch block can access them.
  let lastExecutionResults: ApprovalResult[] | null = null;
  let lastExecutingToolCallIds: string[] = [];
  let lastNeedsUserInputToolCallIds: string[] = [];

  runtime.isProcessing = true;
  runtime.cancelRequested = false;
  runtime.activeAbortController = new AbortController();
  runtime.activeAgentId = agentId ?? null;
  runtime.activeConversationId = conversationId;
  runtime.activeWorkingDirectory = turnWorkingDirectory;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = new Date().toISOString();
  runtime.activeExecutingToolCallIds = [];
  setLoopStatus(runtime, "SENDING_API_REQUEST", {
    agent_id: agentId ?? null,
    conversation_id: conversationId,
  });
  clearRecoveredApprovalStateForScope(runtime, {
    agent_id: agentId ?? null,
    conversation_id: conversationId,
  });
  emitRuntimeStateUpdates(runtime, {
    agent_id: agentId ?? null,
    conversation_id: conversationId,
  });

  try {
    if (!agentId) {
      runtime.isProcessing = false;
      setLoopStatus(runtime, "WAITING_ON_INPUT", {
        conversation_id: conversationId,
      });
      clearActiveRunState(runtime);
      emitRuntimeStateUpdates(runtime, {
        conversation_id: conversationId,
      });
      return;
    }

    if (isDebugEnabled()) {
      console.log(
        `[Listen] Handling message: agentId=${agentId}, requestedConversationId=${requestedConversationId}, conversationId=${conversationId}`,
      );
    }

    if (connectionId) {
      onStatusChange?.("processing", connectionId);
    }

    const normalizedMessages = await normalizeInboundMessages(msg.messages);
    const messagesToSend: Array<MessageCreate | ApprovalCreate> = [];
    let turnToolContextId: string | null = null;
    let queuedInterruptedToolCallIds: string[] = [];

    // Prepend queued interrupted results from a prior cancelled turn.
    const consumed = consumeInterruptQueue(
      runtime,
      agentId || "",
      conversationId,
    );
    if (consumed) {
      messagesToSend.push(consumed.approvalMessage);
      queuedInterruptedToolCallIds = consumed.interruptedToolCallIds;
    }

    messagesToSend.push(...normalizedMessages);

    const firstMessage = normalizedMessages[0];
    const isApprovalMessage =
      firstMessage &&
      "type" in firstMessage &&
      firstMessage.type === "approval" &&
      "approvals" in firstMessage;

    if (!isApprovalMessage) {
      const { parts: reminderParts } = await buildSharedReminderParts(
        buildListenReminderContext({
          agentId: agentId || "",
          state: runtime.reminderState,
          resolvePlanModeReminder: getPlanModeReminder,
        }),
      );

      if (reminderParts.length > 0) {
        for (const m of messagesToSend) {
          if ("role" in m && m.role === "user" && "content" in m) {
            m.content = prependReminderPartsToContent(m.content, reminderParts);
            break;
          }
        }
      }
    }

    let currentInput = messagesToSend;
    let pendingNormalizationInterruptedToolCallIds = [
      ...queuedInterruptedToolCallIds,
    ];
    const buildSendOptions = (): Parameters<typeof sendMessageStream>[2] => ({
      agentId,
      streamTokens: true,
      background: true,
      workingDirectory: turnWorkingDirectory,
      ...(pendingNormalizationInterruptedToolCallIds.length > 0
        ? {
            approvalNormalization: {
              interruptedToolCallIds:
                pendingNormalizationInterruptedToolCallIds,
            },
          }
        : {}),
    });

    const isPureApprovalContinuation = isApprovalOnlyInput(currentInput);

    let stream = isPureApprovalContinuation
      ? await sendApprovalContinuationWithRetry(
          conversationId,
          currentInput,
          buildSendOptions(),
          socket,
          runtime,
          runtime.activeAbortController.signal,
        )
      : await sendMessageStreamWithRetry(
          conversationId,
          currentInput,
          buildSendOptions(),
          socket,
          runtime,
          runtime.activeAbortController.signal,
        );
    if (!stream) {
      return;
    }
    pendingNormalizationInterruptedToolCallIds = [];
    markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
    setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    turnToolContextId = getStreamToolContextId(
      stream as Stream<LettaStreamingResponse>,
    );
    let runIdSent = false;
    let runId: string | undefined;
    const buffers = createBuffers(agentId);

    // Approval loop: continue until end_turn or error
    // eslint-disable-next-line no-constant-condition
    while (true) {
      runIdSent = false;
      let latestErrorText: string | null = null;
      const result = await drainStreamWithResume(
        stream as Stream<LettaStreamingResponse>,
        buffers,
        () => {},
        runtime.activeAbortController.signal,
        undefined,
        ({ chunk, shouldOutput, errorInfo }) => {
          const maybeRunId = (chunk as { run_id?: unknown }).run_id;
          if (typeof maybeRunId === "string") {
            runId = maybeRunId;
            if (runtime.activeRunId !== maybeRunId) {
              runtime.activeRunId = maybeRunId;
            }
            if (!runIdSent) {
              runIdSent = true;
              msgRunIds.push(maybeRunId);
              emitLoopStatusUpdate(socket, runtime, {
                agent_id: agentId,
                conversation_id: conversationId,
              });
            }
          }

          // Emit in-stream errors
          if (errorInfo) {
            latestErrorText = errorInfo.message || latestErrorText;
            emitLoopErrorDelta(socket, runtime, {
              message: errorInfo.message || "Stream error",
              stopReason: (errorInfo.error_type as StopReasonType) || "error",
              isTerminal: false,
              runId: runId || errorInfo.run_id,
              agentId,
              conversationId,
            });
          }

          // Emit chunk as MessageWire for protocol consumers
          if (shouldOutput) {
            const normalizedChunk = normalizeToolReturnWireMessage(
              chunk as unknown as Record<string, unknown>,
            );
            if (normalizedChunk) {
              emitCanonicalMessageDelta(
                socket,
                runtime,
                {
                  ...normalizedChunk,
                  type: "message",
                } as StreamDelta,
                {
                  agent_id: agentId,
                  conversation_id: conversationId,
                },
              );
            }
          }

          return undefined;
        },
      );

      const stopReason = result.stopReason;
      const approvals = result.approvals || [];
      lastApprovalContinuationAccepted = false;

      // Case 1: Turn ended normally
      if (stopReason === "end_turn") {
        runtime.lastStopReason = "end_turn";
        runtime.isProcessing = false;
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        break;
      }

      // Case 2: Explicit cancellation
      if (stopReason === "cancelled") {
        runtime.lastStopReason = "cancelled";
        runtime.isProcessing = false;
        emitInterruptedStatusDelta(socket, runtime, {
          runId: runId || runtime.activeRunId,
          agentId,
          conversationId,
        });
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        break;
      }

      // Case 3: Error (or cancel-induced error)
      if (stopReason !== "requires_approval") {
        const lastRunId =
          runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1];
        const errorDetail = await fetchRunErrorDetail(lastRunId).catch(
          () => null,
        );

        if (
          !runtime.cancelRequested &&
          shouldAttemptPostStopApprovalRecovery({
            stopReason,
            runIdsSeen: msgRunIds.length,
            retries: postStopApprovalRecoveryRetries,
            runErrorDetail: errorDetail,
            latestErrorText,
          })
        ) {
          postStopApprovalRecoveryRetries += 1;
          emitStatusDelta(socket, runtime, {
            message:
              "Recovering from stale approval conflict after interrupted/reconnected turn",
            level: "warning",
            runId: runId || msgRunIds[msgRunIds.length - 1] || undefined,
            agentId,
            conversationId,
          });

          try {
            const client = await getClient();
            const agent = await client.agents.retrieve(agentId || "");
            const { pendingApprovals: existingApprovals } = await getResumeData(
              client,
              agent,
              requestedConversationId,
            );
            currentInput = rebuildInputWithFreshDenials(
              currentInput,
              existingApprovals ?? [],
              "Auto-denied: stale approval from interrupted session",
            );
          } catch {
            // Fetch failed — strip stale approval payload and retry plain message
            currentInput = rebuildInputWithFreshDenials(currentInput, [], "");
          }

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          stream =
            currentInput.length === 1 &&
            currentInput[0] !== undefined &&
            "type" in currentInput[0] &&
            currentInput[0].type === "approval"
              ? await sendApprovalContinuationWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                )
              : await sendMessageStreamWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                );
          if (!stream) {
            return;
          }
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
          setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        if (
          isEmptyResponseRetryable(
            stopReason === "llm_api_error" ? "llm_error" : undefined,
            errorDetail,
            emptyResponseRetries,
            EMPTY_RESPONSE_MAX_RETRIES,
          )
        ) {
          emptyResponseRetries += 1;
          const attempt = emptyResponseRetries;
          const delayMs = getRetryDelayMs({
            category: "empty_response",
            attempt,
          });

          if (attempt >= EMPTY_RESPONSE_MAX_RETRIES) {
            currentInput = [
              ...currentInput,
              {
                type: "message" as const,
                role: "system" as const,
                content:
                  "<system-reminder>The previous response was empty. Please provide a response with either text content or a tool call.</system-reminder>",
              },
            ];
          }

          emitRetryDelta(socket, runtime, {
            message: `Empty LLM response, retrying (attempt ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES})...`,
            reason: "llm_api_error",
            attempt,
            maxAttempts: EMPTY_RESPONSE_MAX_RETRIES,
            delayMs,
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (runtime.activeAbortController.signal.aborted) {
            throw new Error("Cancelled by user");
          }

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          stream =
            currentInput.length === 1 &&
            currentInput[0] !== undefined &&
            "type" in currentInput[0] &&
            currentInput[0].type === "approval"
              ? await sendApprovalContinuationWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                )
              : await sendMessageStreamWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                );
          if (!stream) {
            return;
          }
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
          setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        const retriable = await isRetriablePostStopError(
          (stopReason as StopReasonType) || "error",
          lastRunId,
        );
        if (retriable && llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
          llmApiErrorRetries += 1;
          const attempt = llmApiErrorRetries;
          const delayMs = getRetryDelayMs({
            category: "transient_provider",
            attempt,
            detail: errorDetail,
          });
          const retryMessage =
            getRetryStatusMessage(errorDetail) ||
            `LLM API error encountered, retrying (attempt ${attempt}/${LLM_API_ERROR_MAX_RETRIES})...`;
          emitRetryDelta(socket, runtime, {
            message: retryMessage,
            reason: "llm_api_error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (runtime.activeAbortController.signal.aborted) {
            throw new Error("Cancelled by user");
          }

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          stream =
            currentInput.length === 1 &&
            currentInput[0] !== undefined &&
            "type" in currentInput[0] &&
            currentInput[0].type === "approval"
              ? await sendApprovalContinuationWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                )
              : await sendMessageStreamWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                );
          if (!stream) {
            return;
          }
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
          setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        // Cancel-induced errors should be treated as cancellation, not error.
        // This handles the race where cancel fires during stream drain and the
        // backend returns "error" instead of "cancelled".
        // We're already inside `stopReason !== "requires_approval"`, so this
        // is a true non-approval stop. If cancel was requested, treat as cancelled.
        const effectiveStopReason: StopReasonType = runtime.cancelRequested
          ? "cancelled"
          : (stopReason as StopReasonType) || "error";

        // If effective stop reason is cancelled, route through cancelled semantics (Case 2).
        if (effectiveStopReason === "cancelled") {
          runtime.lastStopReason = "cancelled";
          runtime.isProcessing = false;
          emitInterruptedStatusDelta(socket, runtime, {
            runId: runId || runtime.activeRunId,
            agentId,
            conversationId,
          });
          setLoopStatus(runtime, "WAITING_ON_INPUT", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          clearActiveRunState(runtime);
          emitRuntimeStateUpdates(runtime, {
            agent_id: agentId,
            conversation_id: conversationId,
          });

          break;
        }

        runtime.lastStopReason = effectiveStopReason;
        runtime.isProcessing = false;
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        const errorMessage =
          errorDetail || `Unexpected stop reason: ${stopReason}`;

        emitLoopErrorDelta(socket, runtime, {
          message: errorMessage,
          stopReason: effectiveStopReason,
          isTerminal: true,
          runId: runId,
          agentId,
          conversationId,
        });
        break;
      }

      // Case 4: Requires approval - classify and handle based on permission mode
      if (approvals.length === 0) {
        // Unexpected: requires_approval but no approvals
        runtime.lastStopReason = "error";
        runtime.isProcessing = false;
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        emitLoopErrorDelta(socket, runtime, {
          message: "requires_approval stop returned no approvals",
          stopReason: "error",
          isTerminal: true,
          agentId,
          conversationId,
        });
        break;
      }

      // Persist origin correlation for this approval wait so a later recovery
      // can continue the same dequeued-turn run block.
      rememberPendingApprovalBatchIds(runtime, approvals, dequeuedBatchId);

      // Classify approvals (auto-allow, auto-deny, needs user input)
      // Don't treat "ask" as deny - cloud UI can handle approvals
      // Interactive tools (AskUserQuestion, EnterPlanMode, ExitPlanMode) always need user input
      const { autoAllowed, autoDenied, needsUserInput } =
        await classifyApprovals(approvals, {
          alwaysRequiresUserInput: isInteractiveApprovalTool,
          treatAskAsDeny: false, // Let cloud UI handle approvals
          requireArgsForAutoApprove: true,
          missingNameReason: "Tool call incomplete - missing name",
          workingDirectory: turnWorkingDirectory,
        });

      // Snapshot all tool_call_ids before entering approval wait so cancel can
      // synthesize denial results even after pendingApprovalResolvers is cleared.
      lastNeedsUserInputToolCallIds = needsUserInput.map(
        (ac) => ac.approval.toolCallId,
      );
      lastExecutionResults = null;

      // Build decisions list (before needsUserInput gate so both paths accumulate here)
      type Decision =
        | {
            type: "approve";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
          }
        | {
            type: "deny";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
            reason: string;
          };

      const decisions: Decision[] = [
        ...autoAllowed.map((ac) => ({
          type: "approve" as const,
          approval: ac.approval,
        })),
        ...autoDenied.map((ac) => ({
          type: "deny" as const,
          approval: ac.approval,
          reason: ac.denyReason || ac.permission.reason || "Permission denied",
        })),
      ];

      // Handle tools that need user input
      if (needsUserInput.length > 0) {
        runtime.lastStopReason = "requires_approval";
        setLoopStatus(runtime, "WAITING_ON_APPROVAL", {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        // Block in-loop via the control protocol for all device approvals.
        for (const ac of needsUserInput) {
          const requestId = `perm-${ac.approval.toolCallId}`;
          const diffs = await computeDiffPreviews(
            ac.approval.toolName,
            ac.parsedArgs,
            turnWorkingDirectory,
          );
          const controlRequest: ControlRequest = {
            type: "control_request",
            request_id: requestId,
            request: {
              subtype: "can_use_tool",
              tool_name: ac.approval.toolName,
              input: ac.parsedArgs,
              tool_call_id: ac.approval.toolCallId,
              permission_suggestions: [],
              blocked_path: null,
              ...(diffs.length > 0 ? { diffs } : {}),
            },
            agent_id: agentId,
            conversation_id: conversationId,
          };

          const responseBody = await requestApprovalOverWS(
            runtime,
            socket,
            requestId,
            controlRequest,
          );

          if ("decision" in responseBody) {
            const response = responseBody.decision as ApprovalResponseDecision;
            if (response.behavior === "allow") {
              const finalApproval = response.updated_input
                ? {
                    ...ac.approval,
                    toolArgs: JSON.stringify(response.updated_input),
                  }
                : ac.approval;
              decisions.push({ type: "approve", approval: finalApproval });
            } else {
              decisions.push({
                type: "deny",
                approval: ac.approval,
                reason: response?.message || "Denied via WebSocket",
              });
            }
          } else {
            const denyReason = responseBody.error;
            decisions.push({
              type: "deny",
              approval: ac.approval,
              reason: denyReason,
            });
          }
        }
      }

      // Snapshot executing tool_call_ids before execution starts so cancel can
      // preserve tool-error parity even if execution aborts mid-await.
      lastExecutingToolCallIds = decisions
        .filter(
          (decision): decision is Extract<Decision, { type: "approve" }> =>
            decision.type === "approve",
        )
        .map((decision) => decision.approval.toolCallId);
      runtime.activeExecutingToolCallIds = [...lastExecutingToolCallIds];
      setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", {
        agent_id: agentId,
        conversation_id: conversationId,
      });
      emitRuntimeStateUpdates(runtime, {
        agent_id: agentId,
        conversation_id: conversationId,
      });
      const executionRunId =
        runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1];
      emitToolExecutionStartedEvents(socket, runtime, {
        toolCallIds: lastExecutingToolCallIds,
        runId: executionRunId,
        agentId,
        conversationId,
      });

      // Execute approved/denied tools
      const executionResults = await executeApprovalBatch(
        decisions,
        undefined,
        {
          toolContextId: turnToolContextId ?? undefined,
          abortSignal: runtime.activeAbortController.signal,
          workingDirectory: turnWorkingDirectory,
        },
      );
      const persistedExecutionResults =
        normalizeExecutionResultsForInterruptParity(
          runtime,
          executionResults,
          lastExecutingToolCallIds,
        );
      validateApprovalResultIds(
        decisions.map((decision) => ({
          approval: {
            toolCallId: decision.approval.toolCallId,
          },
        })),
        persistedExecutionResults,
      );
      emitToolExecutionFinishedEvents(socket, runtime, {
        approvals: persistedExecutionResults,
        runId: executionRunId,
        agentId,
        conversationId,
      });
      lastExecutionResults = persistedExecutionResults;
      // WS-first parity: publish tool-return terminal outcomes immediately on
      // normal approval execution, before continuation stream send.
      emitInterruptToolReturnMessage(
        socket,
        runtime,
        persistedExecutionResults,
        runtime.activeRunId ||
          runId ||
          msgRunIds[msgRunIds.length - 1] ||
          undefined,
        "tool-return",
      );
      // Create fresh approval stream for next iteration
      currentInput = [
        {
          type: "approval",
          approvals: persistedExecutionResults,
        },
      ];
      setLoopStatus(runtime, "SENDING_API_REQUEST", {
        agent_id: agentId,
        conversation_id: conversationId,
      });
      stream = await sendApprovalContinuationWithRetry(
        conversationId,
        currentInput,
        buildSendOptions(),
        socket,
        runtime,
        runtime.activeAbortController.signal,
      );
      if (!stream) {
        return;
      }
      pendingNormalizationInterruptedToolCallIds = [];
      clearPendingApprovalBatchIds(
        runtime,
        decisions.map((decision) => decision.approval),
      );
      await debugLogApprovalResumeState(runtime, {
        agentId,
        conversationId,
        expectedToolCallIds: collectDecisionToolCallIds(
          decisions.map((decision) => ({
            approval: {
              toolCallId: decision.approval.toolCallId,
            },
          })),
        ),
        sentToolCallIds: collectApprovalResultToolCallIds(
          persistedExecutionResults,
        ),
      });
      markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
      setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
        agent_id: agentId,
        conversation_id: conversationId,
      });

      // The continuation request has been accepted by the backend, but do not
      // drop the local approval snapshots until that continuation stream yields
      // a stable stop. Catch/interrupt paths still need to distinguish
      // "already submitted" from "not yet submitted".
      lastApprovalContinuationAccepted = true;
      runtime.activeExecutingToolCallIds = [];
      emitRuntimeStateUpdates(runtime, {
        agent_id: agentId,
        conversation_id: conversationId,
      });

      turnToolContextId = getStreamToolContextId(
        stream as Stream<LettaStreamingResponse>,
      );
    }
  } catch (error) {
    if (runtime.cancelRequested) {
      if (!lastApprovalContinuationAccepted) {
        // Queue interrupted tool-call resolutions for the next message turn
        // only if the approval continuation has not yet been accepted.
        populateInterruptQueue(runtime, {
          lastExecutionResults,
          lastExecutingToolCallIds,
          lastNeedsUserInputToolCallIds,
          agentId: agentId || "",
          conversationId,
        });
        const approvalsForEmission = getInterruptApprovalsForEmission(runtime, {
          lastExecutionResults,
          agentId: agentId || "",
          conversationId,
        });
        if (approvalsForEmission) {
          emitToolExecutionFinishedEvents(socket, runtime, {
            approvals: approvalsForEmission,
            runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
            agentId: agentId || "",
            conversationId,
          });
          emitInterruptToolReturnMessage(
            socket,
            runtime,
            approvalsForEmission,
            runtime.activeRunId || msgRunIds[msgRunIds.length - 1] || undefined,
          );
        }
      }

      runtime.lastStopReason = "cancelled";
      runtime.isProcessing = false;
      emitInterruptedStatusDelta(socket, runtime, {
        runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
        agentId: agentId || null,
        conversationId,
      });
      setLoopStatus(runtime, "WAITING_ON_INPUT", {
        agent_id: agentId || null,
        conversation_id: conversationId,
      });
      clearActiveRunState(runtime);
      emitRuntimeStateUpdates(runtime, {
        agent_id: agentId || null,
        conversation_id: conversationId,
      });

      return;
    }

    runtime.lastStopReason = "error";
    runtime.isProcessing = false;
    setLoopStatus(runtime, "WAITING_ON_INPUT", {
      agent_id: agentId || null,
      conversation_id: conversationId,
    });
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, {
      agent_id: agentId || null,
      conversation_id: conversationId,
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    emitLoopErrorDelta(socket, runtime, {
      message: errorMessage,
      stopReason: "error",
      isTerminal: true,
      agentId: agentId || undefined,
      conversationId,
    });
    if (isDebugEnabled()) {
      console.error("[Listen] Error handling message:", error);
    }
  } finally {
    runtime.activeAbortController = null;
    runtime.cancelRequested = false;
    runtime.isRecoveringApprovals = false;
    runtime.activeExecutingToolCallIds = [];
  }
}

/**
 * Check if listener is currently active.
 */
export function isListenerActive(): boolean {
  return activeRuntime !== null && activeRuntime.socket !== null;
}

/**
 * Stop the active listener connection.
 */
export function stopListenerClient(): void {
  if (!activeRuntime) {
    return;
  }

  const runtime = activeRuntime;
  activeRuntime = null;
  stopRuntime(runtime, true);
}

export const __listenClientTestUtils = {
  createRuntime,
  stopRuntime,
  resolveRuntimeScope,
  buildDeviceStatus,
  buildLoopStatus,
  buildQueueSnapshot,
  emitDeviceStatusUpdate,
  emitLoopStatusUpdate,
  handleCwdChange,
  getConversationWorkingDirectory,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolveRecoveryBatchId,
  clearPendingApprovalBatchIds,
  populateInterruptQueue,
  setConversationWorkingDirectory,
  consumeInterruptQueue,
  stashRecoveredApprovalInterrupts,
  extractInterruptToolReturns,
  emitInterruptToolReturnMessage,
  emitInterruptedStatusDelta,
  emitRetryDelta,
  getInterruptApprovalsForEmission,
  normalizeToolReturnWireMessage,
  normalizeExecutionResultsForInterruptParity,
  shouldAttemptPostStopApprovalRecovery,
  getApprovalContinuationRecoveryDisposition,
  markAwaitingAcceptedApprovalContinuationRunId,
  normalizeMessageContentImages,
  normalizeInboundMessages,
  recoverApprovalStateForSync,
  clearRecoveredApprovalStateForScope,
  emitStateSync,
};
