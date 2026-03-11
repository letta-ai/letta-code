/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import { readdir, realpath, stat } from "node:fs/promises";
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
  isInvalidToolCallIdsError,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  shouldAttemptApprovalRecovery,
} from "../agent/turn-recovery-policy";
import { createBuffers } from "../cli/helpers/accumulator";
import { classifyApprovals } from "../cli/helpers/approvalClassification";
import { generatePlanFilePath } from "../cli/helpers/planName";
import { drainStreamWithResume } from "../cli/helpers/stream";
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
import { loadTools } from "../tools/manager";
import type {
  AutoApprovalMessage,
  CancelAckMessage,
  CanUseToolResponse,
  ControlRequest,
  ControlResponseBody,
  ErrorMessage,
  MessageWire,
  ResultMessage as ProtocolResultMessage,
  QueueLifecycleEvent,
  QueueSnapshotMessage,
  RecoveryMessage,
  RetryMessage,
  StopReasonType,
  SyncCompleteMessage,
  TranscriptBackfillMessage,
  TranscriptSupplementMessage,
} from "../types/protocol";
import { getListenerBlockedReason } from "./helpers/listenerQueueAdapter";

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

interface PingMessage {
  type: "ping";
}

interface PongMessage {
  type: "pong";
}

interface StatusMessage {
  type: "status";
  currentMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  lastStopReason: string | null;
  isProcessing: boolean;
}

interface IncomingMessage {
  type: "message";
  agentId?: string;
  conversationId?: string;
  messages: Array<
    (MessageCreate & { client_message_id?: string }) | ApprovalCreate
  >;
}

interface RunStartedMessage {
  type: "run_started";
  runId: string;
  batch_id: string;
  event_seq?: number;
  session_id?: string;
  agent_id?: string;
  conversation_id?: string;
}

interface RunRequestErrorMessage {
  type: "run_request_error";
  error: {
    status?: number;
    body?: Record<string, unknown>;
    message?: string;
  };
  batch_id?: string;
  event_seq?: number;
  session_id?: string;
  agent_id?: string;
  conversation_id?: string;
}

interface ModeChangeMessage {
  type: "mode_change";
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

interface WsControlResponse {
  type: "control_response";
  response: ControlResponseBody;
}

interface ModeChangedMessage {
  type: "mode_changed";
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  success: boolean;
  error?: string;
  event_seq?: number;
  session_id?: string;
}

interface GetStatusMessage {
  type: "get_status";
}

interface GetStateMessage {
  type: "get_state";
  agentId?: string | null;
  conversationId?: string | null;
}

interface ChangeCwdMessage {
  type: "change_cwd";
  agentId?: string | null;
  conversationId?: string | null;
  cwd: string;
}

interface ListFoldersInDirectoryMessage {
  type: "list_folders_in_directory";
  path: string;
  agentId?: string | null;
  conversationId?: string | null;
}

interface ListFoldersInDirectoryResponseMessage {
  type: "list_folders_in_directory_response";
  path: string;
  folders: string[];
  hasMore: boolean;
  success: boolean;
  error?: string;
  event_seq?: number;
  session_id?: string;
}

interface CancelRunMessage {
  type: "cancel_run";
  request_id?: string;
  run_id?: string | null;
}

interface RecoverPendingApprovalsMessage {
  type: "recover_pending_approvals";
  agentId?: string;
  conversationId?: string;
}

interface StatusResponseMessage {
  type: "status_response";
  currentMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  lastStopReason: string | null;
  isProcessing: boolean;
  event_seq?: number;
  session_id?: string;
}

interface StateResponseMessage {
  type: "state_response";
  schema_version: 1;
  session_id: string;
  snapshot_id: string;
  generated_at: string;
  state_seq: number;
  cwd: string;
  configured_cwd: string;
  active_turn_cwd: string | null;
  cwd_agent_id: string | null;
  cwd_conversation_id: string | null;
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  is_processing: boolean;
  last_stop_reason: string | null;
  control_response_capable: boolean;
  active_run: {
    run_id: string | null;
    agent_id: string | null;
    conversation_id: string | null;
    started_at: string | null;
  };
  pending_control_requests: Array<{
    request_id: string;
    request: ControlRequest["request"];
  }>;
  pending_interrupt: {
    agent_id: string;
    conversation_id: string;
    interrupted_tool_call_ids: string[];
    tool_returns: InterruptToolReturn[];
  } | null;
  queue: {
    queue_len: number;
    pending_turns: number;
    items: Array<{
      id: string;
      client_message_id: string;
      kind: string;
      source: string;
      content: unknown;
      enqueued_at: string;
    }>;
  };
  event_seq?: number;
}

interface CwdChangedMessage {
  type: "cwd_changed";
  agent_id: string | null;
  conversation_id: string;
  cwd: string;
  success: boolean;
  error?: string;
  event_seq?: number;
  session_id?: string;
}

type ServerMessage =
  | PongMessage
  | StatusMessage
  | IncomingMessage
  | ModeChangeMessage
  | GetStatusMessage
  | GetStateMessage
  | ChangeCwdMessage
  | ListFoldersInDirectoryMessage
  | CancelRunMessage
  | RecoverPendingApprovalsMessage
  | WsControlResponse;
type ClientMessage =
  | PingMessage
  | RunStartedMessage
  | RunRequestErrorMessage
  | ModeChangedMessage
  | CwdChangedMessage
  | ListFoldersInDirectoryResponseMessage
  | StatusResponseMessage
  | StateResponseMessage;

type PendingApprovalResolver = {
  resolve: (response: ControlResponseBody) => void;
  reject: (reason: Error) => void;
  controlRequest?: ControlRequest;
};

type ListenerRuntime = {
  socket: WebSocket | null;
  heartbeatInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
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
  /** True when a cancel_run request has been issued for the active turn. */
  cancelRequested: boolean;
  /** Queue lifecycle tracking — parallel tracking layer, does not affect message processing. */
  queueRuntime: QueueRuntime;
  /** Correlates queued queue item ids to original inbound frames. */
  queuedMessagesByItemId: Map<string, IncomingMessage>;
  /** True while a queue drain pass is actively running. */
  queuePumpActive: boolean;
  /** Dedupes queue pump scheduling onto messageQueue chain. */
  queuePumpScheduled: boolean;
  /** Queue backlog metric for state snapshot visibility. */
  pendingTurns: number;
  /** Optional debug hook for WS event logging. */
  onWsEvent?: StartListenerOptions["onWsEvent"];
  /** Prevent duplicate concurrent pending-approval recovery passes. */
  isRecoveringApprovals: boolean;
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
};

// Listen mode supports one active connection per process.
let activeRuntime: ListenerRuntime | null = null;

/**
 * Handle mode change request from cloud
 */
function handleModeChange(msg: ModeChangeMessage, socket: WebSocket): void {
  try {
    permissionMode.setMode(msg.mode);

    // If entering plan mode, generate and set plan file path
    if (msg.mode === "plan" && !permissionMode.getPlanFilePath()) {
      const planFilePath = generatePlanFilePath();
      permissionMode.setPlanFilePath(planFilePath);
    }

    // Send success acknowledgment
    sendClientMessage(socket, {
      type: "mode_changed",
      mode: msg.mode,
      success: true,
    });

    if (process.env.DEBUG) {
      console.log(`[Listen] Mode changed to: ${msg.mode}`);
    }
  } catch (error) {
    // Send failure acknowledgment
    sendClientMessage(socket, {
      type: "mode_changed",
      mode: msg.mode,
      success: false,
      error: error instanceof Error ? error.message : "Mode change failed",
    });

    if (process.env.DEBUG) {
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
    sendClientMessage(
      socket,
      {
        type: "cwd_changed",
        agent_id: agentId,
        conversation_id: conversationId,
        cwd: normalizedPath,
        success: true,
      },
      runtime,
    );
    sendStateSnapshot(socket, runtime, agentId, conversationId);
  } catch (error) {
    sendClientMessage(
      socket,
      {
        type: "cwd_changed",
        agent_id: agentId,
        conversation_id: conversationId,
        cwd: msg.cwd,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Working directory change failed",
      },
      runtime,
    );
  }
}

const MAX_LIST_FOLDERS = 100;

async function handleListFoldersInDirectory(
  msg: ListFoldersInDirectoryMessage,
  socket: WebSocket,
  runtime: ListenerRuntime,
): Promise<void> {
  try {
    const requestedPath = msg.path?.trim();
    if (!requestedPath) {
      throw new Error("Path cannot be empty");
    }

    const resolvedPath = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(process.cwd(), requestedPath);
    const normalizedPath = await realpath(resolvedPath);
    const stats = await stat(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    const entries = await readdir(normalizedPath, { withFileTypes: true });
    const allFolders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();

    const folders = allFolders.slice(0, MAX_LIST_FOLDERS);
    const hasMore = allFolders.length > MAX_LIST_FOLDERS;

    sendClientMessage(
      socket,
      {
        type: "list_folders_in_directory_response",
        path: normalizedPath,
        folders,
        hasMore,
        success: true,
      },
      runtime,
    );
  } catch (error) {
    sendClientMessage(
      socket,
      {
        type: "list_folders_in_directory_response",
        path: msg.path,
        folders: [],
        hasMore: false,
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list folders",
      },
      runtime,
    );
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
    pendingApprovalBatchByToolCallId: new Map<string, string>(),
    pendingInterruptedResults: null,
    pendingInterruptedContext: null,
    continuationEpoch: 0,
    activeExecutingToolCallIds: [],
    pendingInterruptedToolCallIds: null,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: new Map<string, string>(),
    queuedMessagesByItemId: new Map<string, IncomingMessage>(),
    queuePumpActive: false,
    queuePumpScheduled: false,
    pendingTurns: 0,
    // queueRuntime assigned below — needs runtime ref in callbacks
    queueRuntime: null as unknown as QueueRuntime,
  };
  runtime.queueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          const content = item.kind === "message" ? item.content : item.text;
          emitToWS(runtime.socket, {
            type: "queue_item_enqueued",
            id: item.id,
            item_id: item.id,
            client_message_id: item.clientMessageId ?? `cm-${item.id}`,
            source: item.source,
            kind: item.kind,
            content,
            enqueued_at: new Date(item.enqueuedAt).toISOString(),
            queue_len: queueLen,
            session_id: runtime.sessionId,
            uuid: `q-enq-${item.id}`,
            ...getQueueItemScope(item),
          });
        }
      },
      onDequeued: (batch) => {
        runtime.pendingTurns = batch.queueLenAfter;
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_batch_dequeued",
            batch_id: batch.batchId,
            item_ids: batch.items.map((i) => i.id),
            merged_count: batch.mergedCount,
            queue_len_after: batch.queueLenAfter,
            session_id: runtime.sessionId,
            uuid: `q-deq-${batch.batchId}`,
            ...getQueueItemsScope(batch.items),
          });
        }
      },
      onBlocked: (reason, queueLen) => {
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_blocked",
            reason,
            queue_len: queueLen,
            session_id: runtime.sessionId,
            uuid: `q-blk-${crypto.randomUUID()}`,
            ...getQueueItemScope(runtime.queueRuntime.items[0]),
          });
        }
      },
      onCleared: (reason, clearedCount, items) => {
        runtime.pendingTurns = 0;
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_cleared",
            reason,
            cleared_count: clearedCount,
            session_id: runtime.sessionId,
            uuid: `q-clr-${crypto.randomUUID()}`,
            ...getQueueItemsScope(items),
          });
        }
      },
      onDropped: (item, reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_item_dropped",
            id: item.id,
            item_id: item.id,
            reason,
            queue_len: queueLen,
            session_id: runtime.sessionId,
            uuid: `q-drp-${item.id}`,
            ...getQueueItemScope(item),
          });
        }
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

function setConversationWorkingDirectory(
  runtime: ListenerRuntime,
  agentId: string | null,
  conversationId: string,
  workingDirectory: string,
): void {
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  if (workingDirectory === runtime.bootWorkingDirectory) {
    runtime.workingDirectoryByConversation.delete(scopeKey);
    return;
  }

  runtime.workingDirectoryByConversation.set(scopeKey, workingDirectory);
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

function isValidControlResponseBody(
  value: unknown,
): value is ControlResponseBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeResponse = value as {
    subtype?: unknown;
    request_id?: unknown;
  };
  return (
    typeof maybeResponse.subtype === "string" &&
    typeof maybeResponse.request_id === "string"
  );
}

export function parseServerMessage(
  data: WebSocket.RawData,
): ServerMessage | null {
  try {
    const raw = typeof data === "string" ? data : data.toString();
    const parsed = JSON.parse(raw) as { type?: string; response?: unknown };
    if (
      parsed.type === "pong" ||
      parsed.type === "status" ||
      parsed.type === "message" ||
      parsed.type === "mode_change" ||
      parsed.type === "get_status" ||
      parsed.type === "get_state" ||
      parsed.type === "change_cwd" ||
      parsed.type === "list_folders_in_directory" ||
      parsed.type === "cancel_run" ||
      parsed.type === "recover_pending_approvals"
    ) {
      return parsed as ServerMessage;
    }
    if (
      parsed.type === "control_response" &&
      isValidControlResponseBody(parsed.response)
    ) {
      return parsed as ServerMessage;
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

function getQueueItemContent(item: QueueItem): unknown {
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
  return getListenerBlockedReason({
    isProcessing: runtime.isProcessing,
    pendingApprovalsLen: runtime.pendingApprovalResolvers.size,
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
      if (process.env.DEBUG) {
        console.error("[Listen] Error in queue pump:", error);
      }
      opts.onStatusChange?.("idle", opts.connectionId);
    });
}

function buildStateResponse(
  runtime: ListenerRuntime,
  stateSeq: number,
  agentId?: string | null,
  conversationId?: string | null,
): StateResponseMessage {
  const scopedAgentId = normalizeCwdAgentId(agentId);
  const scopedConversationId = normalizeConversationId(conversationId);
  const configuredWorkingDirectory = getConversationWorkingDirectory(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  const activeTurnWorkingDirectory =
    runtime.activeAgentId === scopedAgentId &&
    runtime.activeConversationId === scopedConversationId
      ? runtime.activeWorkingDirectory
      : null;
  const queueItems = runtime.queueRuntime.items.map((item) => ({
    id: item.id,
    client_message_id: item.clientMessageId ?? `cm-${item.id}`,
    kind: item.kind,
    source: item.source,
    content: getQueueItemContent(item),
    enqueued_at: new Date(item.enqueuedAt).toISOString(),
  }));

  const pendingControlRequests = Array.from(
    runtime.pendingApprovalResolvers.entries(),
  ).flatMap(([requestId, pending]) => {
    if (!pending.controlRequest) {
      return [];
    }
    return [
      {
        request_id: requestId,
        request: pending.controlRequest.request,
      },
    ];
  });

  return {
    type: "state_response",
    schema_version: 1,
    session_id: runtime.sessionId,
    snapshot_id: `snapshot-${crypto.randomUUID()}`,
    generated_at: new Date().toISOString(),
    state_seq: stateSeq,
    event_seq: stateSeq,
    cwd: configuredWorkingDirectory,
    configured_cwd: configuredWorkingDirectory,
    active_turn_cwd: activeTurnWorkingDirectory,
    cwd_agent_id: scopedAgentId,
    cwd_conversation_id: scopedConversationId,
    mode: permissionMode.getMode(),
    is_processing: runtime.isProcessing,
    last_stop_reason: runtime.lastStopReason,
    control_response_capable: true,
    active_run: {
      run_id: runtime.activeRunId,
      agent_id: runtime.activeAgentId,
      conversation_id: runtime.activeConversationId,
      started_at: runtime.activeRunStartedAt,
    },
    pending_control_requests: pendingControlRequests,
    pending_interrupt: buildPendingInterruptState(runtime),
    queue: {
      queue_len: runtime.queueRuntime.length,
      pending_turns: runtime.pendingTurns,
      items: queueItems,
    },
  };
}

function sendStateSnapshot(
  socket: WebSocket,
  runtime: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): void {
  const stateSeq = nextEventSeq(runtime);
  if (stateSeq === null) {
    return;
  }
  const stateResponse = buildStateResponse(
    runtime,
    stateSeq,
    agentId,
    conversationId,
  );
  sendClientMessage(socket, stateResponse, runtime);
}

function emitCancelAck(
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    requestId: string;
    accepted: boolean;
    reason?: string;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  emitToWS(socket, {
    type: "cancel_ack",
    request_id: params.requestId,
    accepted: params.accepted,
    reason: params.reason,
    run_id: params.runId ?? runtime.activeRunId,
    agent_id: params.agentId ?? runtime.activeAgentId ?? undefined,
    conversation_id:
      params.conversationId ?? runtime.activeConversationId ?? undefined,
    session_id: runtime.sessionId,
    uuid: `cancel-ack-${params.requestId}`,
  } as CancelAckMessage);
}

function emitTurnResult(
  socket: WebSocket,
  runtime: ListenerRuntime,
  params: {
    subtype: ProtocolResultMessage["subtype"];
    agentId: string;
    conversationId: string;
    durationMs: number;
    numTurns: number;
    runIds: string[];
    stopReason?: StopReasonType;
  },
): void {
  emitToWS(socket, {
    type: "result",
    subtype: params.subtype,
    agent_id: params.agentId,
    conversation_id: params.conversationId,
    duration_ms: params.durationMs,
    duration_api_ms: 0,
    num_turns: params.numTurns,
    result: null,
    run_ids: params.runIds,
    usage: null,
    ...(params.stopReason ? { stop_reason: params.stopReason } : {}),
    session_id: runtime.sessionId,
    uuid: `result-${crypto.randomUUID()}`,
  });
}

function sendClientMessage(
  socket: WebSocket,
  payload: ClientMessage,
  runtime: ListenerRuntime | null = activeRuntime,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    let outbound = payload as unknown as Record<string, unknown>;
    if (payload.type !== "ping") {
      const hasEventSeq = typeof outbound.event_seq === "number";
      if (!hasEventSeq) {
        const eventSeq = nextEventSeq(runtime);
        if (eventSeq !== null) {
          outbound = {
            ...outbound,
            event_seq: eventSeq,
            session_id:
              typeof outbound.session_id === "string"
                ? outbound.session_id
                : runtime?.sessionId,
          };
        }
      } else if (
        typeof outbound.session_id !== "string" &&
        runtime?.sessionId
      ) {
        outbound = {
          ...outbound,
          session_id: runtime.sessionId,
        };
      }
    }
    safeEmitWsEvent("send", "client", outbound);
    socket.send(JSON.stringify(outbound));
  }
}

function sendControlMessageOverWebSocket(
  socket: WebSocket,
  payload: ControlRequest,
  runtime: ListenerRuntime | null = activeRuntime,
): void {
  // Central hook for protocol-only outbound WS messages so future
  // filtering/mutation can be added without touching approval flow.
  const eventSeq = nextEventSeq(runtime);
  const outbound =
    eventSeq === null
      ? payload
      : {
          ...payload,
          event_seq: eventSeq,
          session_id: runtime?.sessionId,
        };
  safeEmitWsEvent("send", "control", outbound);
  socket.send(JSON.stringify(outbound));
}

// ── Typed protocol event adapter ────────────────────────────────

export type WsProtocolEvent =
  | MessageWire
  | AutoApprovalMessage
  | CancelAckMessage
  | ErrorMessage
  | RetryMessage
  | RecoveryMessage
  | ProtocolResultMessage
  | QueueLifecycleEvent
  | TranscriptBackfillMessage
  | QueueSnapshotMessage
  | SyncCompleteMessage
  | TranscriptSupplementMessage;

/**
 * Single adapter for all outbound typed protocol events.
 * Passthrough for now — provides a seam for future filtering/versioning/redacting.
 */
function emitToWS(socket: WebSocket, event: WsProtocolEvent): void {
  if (socket.readyState === WebSocket.OPEN) {
    const runtime = activeRuntime;
    const eventSeq = nextEventSeq(runtime);
    const eventRecord = event as unknown as Record<string, unknown>;
    const outbound =
      eventSeq === null
        ? eventRecord
        : {
            ...eventRecord,
            event_seq: eventSeq,
            session_id:
              typeof eventRecord.session_id === "string"
                ? eventRecord.session_id
                : runtime?.sessionId,
          };
    safeEmitWsEvent("send", "protocol", outbound);
    socket.send(JSON.stringify(outbound));
  }
}

const LLM_API_ERROR_MAX_RETRIES = 3;
const MAX_PRE_STREAM_RECOVERY = 2;
const MAX_POST_STOP_APPROVAL_RECOVERY = 2;

function shouldAttemptPostStopApprovalRecovery(params: {
  stopReason: string | null | undefined;
  runIdsSeen: number;
  retries: number;
  runErrorDetail: string | null;
  latestErrorText: string | null;
}): boolean {
  const invalidToolCallIdsDetected =
    isInvalidToolCallIdsError(params.runErrorDetail) ||
    isInvalidToolCallIdsError(params.latestErrorText);
  const approvalPendingDetected =
    isApprovalPendingError(params.runErrorDetail) ||
    isApprovalPendingError(params.latestErrorText);

  // Heuristic fallback:
  // If the stream stops with generic "error" before any run_id was emitted,
  // this is frequently a stale approval conflict after reconnect/interrupt.
  const genericNoRunError =
    params.stopReason === "error" && params.runIdsSeen === 0;

  return shouldAttemptApprovalRecovery({
    approvalPendingDetected:
      invalidToolCallIdsDetected ||
      approvalPendingDetected ||
      genericNoRunError,
    retries: params.retries,
    maxRetries: MAX_POST_STOP_APPROVAL_RECOVERY,
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

function buildPendingInterruptState(
  runtime: ListenerRuntime,
): StateResponseMessage["pending_interrupt"] {
  const context = runtime.pendingInterruptedContext;
  const approvals = runtime.pendingInterruptedResults;
  const interruptedToolCallIds = runtime.pendingInterruptedToolCallIds;
  if (
    !context ||
    !approvals ||
    approvals.length === 0 ||
    !interruptedToolCallIds ||
    interruptedToolCallIds.length === 0
  ) {
    return null;
  }

  const interruptedSet = new Set(interruptedToolCallIds);
  const toolReturns = extractInterruptToolReturns(approvals).filter(
    (toolReturn) => interruptedSet.has(toolReturn.tool_call_id),
  );
  if (toolReturns.length === 0) {
    return null;
  }

  return {
    agent_id: context.agentId,
    conversation_id: context.conversationId,
    interrupted_tool_call_ids: [...interruptedToolCallIds],
    tool_returns: toolReturns,
  };
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
    emitToWS(socket, {
      type: "message",
      message_type: "tool_return_message",
      id: `message-${crypto.randomUUID()}`,
      date: new Date().toISOString(),
      run_id: resolvedRunId,
      agent_id: runtime.activeAgentId ?? undefined,
      tool_returns: [
        {
          tool_call_id: toolReturn.tool_call_id,
          status: toolReturn.status,
          tool_return: toolReturn.tool_return,
          ...(toolReturn.stdout ? { stdout: toolReturn.stdout } : {}),
          ...(toolReturn.stderr ? { stderr: toolReturn.stderr } : {}),
        },
      ],
      session_id: runtime.sessionId,
      uuid: `${uuidPrefix}-${crypto.randomUUID()}`,
      conversation_id: runtime.activeConversationId ?? undefined,
    } as unknown as MessageWire);
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

  if (process.env.DEBUG) {
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

  // Atomic clear — always, regardless of context match.
  // Stale results for wrong context are discarded, not retried.
  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  runtime.pendingApprovalBatchByToolCallId.clear();

  return result;
}

/**
 * Attempt to resolve stale pending approvals by fetching them from the backend
 * and auto-denying. This is the Phase 3 bounded recovery mechanism — it does NOT
 * touch pendingInterruptedResults (that's exclusively owned by handleIncomingMessage).
 */
async function resolveStaleApprovals(
  runtime: ListenerRuntime,
  abortSignal: AbortSignal,
): Promise<void> {
  if (!runtime.activeAgentId) return;

  const client = await getClient();
  let agent: Awaited<ReturnType<typeof client.agents.retrieve>>;
  try {
    agent = await client.agents.retrieve(runtime.activeAgentId);
  } catch (err) {
    // 404 = agent deleted, 422 = invalid ID — both mean nothing to recover
    if (err instanceof APIError && (err.status === 404 || err.status === 422)) {
      return;
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
      return;
    }
    throw err;
  }

  const pendingApprovals = resumeData.pendingApprovals || [];
  if (pendingApprovals.length === 0) return;
  if (abortSignal.aborted) throw new Error("Cancelled");

  const denialResults: ApprovalResult[] = pendingApprovals.map((approval) => ({
    type: "approval" as const,
    tool_call_id: approval.toolCallId,
    approve: false,
    reason: "Auto-denied during pre-stream approval recovery",
  }));

  const recoveryConversationId = runtime.activeConversationId || "default";
  const recoveryStream = await sendMessageStream(
    recoveryConversationId,
    [{ type: "approval", approvals: denialResults }],
    {
      agentId: runtime.activeAgentId,
      streamTokens: true,
      background: true,
      workingDirectory:
        runtime.activeWorkingDirectory ??
        getConversationWorkingDirectory(
          runtime,
          runtime.activeAgentId,
          recoveryConversationId,
        ),
    },
    { maxRetries: 0, signal: abortSignal },
  );

  const drainResult = await drainStreamWithResume(
    recoveryStream as Stream<LettaStreamingResponse>,
    createBuffers(runtime.activeAgentId),
    () => {},
    abortSignal,
  );

  if (drainResult.stopReason === "error") {
    throw new Error("Pre-stream approval recovery drain ended with error");
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }

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

      if (action === "resolve_approval_pending") {
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
            await resolveStaleApprovals(runtime, abortSignal);
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
            `Pre-stream approval conflict (resolve_approval_pending) after ${preStreamRecoveryAttempts} recovery attempts`,
        );
      }

      if (action === "retry_transient") {
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

        emitToWS(socket, {
          type: "retry",
          reason: "llm_api_error",
          attempt,
          max_attempts: LLM_API_ERROR_MAX_RETRIES,
          delay_ms: delayMs,
          session_id: runtime.sessionId,
          uuid: `retry-${crypto.randomUUID()}`,
          agent_id: runtime.activeAgentId ?? undefined,
          conversation_id: conversationId,
        } as RetryMessage);

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      if (action === "retry_conversation_busy") {
        const attempt = conversationBusyRetries + 1;
        const delayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt,
        });
        conversationBusyRetries = attempt;

        emitToWS(socket, {
          type: "retry",
          reason: "error",
          attempt,
          max_attempts: MAX_CONVERSATION_BUSY_RETRIES,
          delay_ms: delayMs,
          session_id: runtime.sessionId,
          uuid: `retry-${crypto.randomUUID()}`,
          agent_id: runtime.activeAgentId ?? undefined,
          conversation_id: conversationId,
        } as RetryMessage);

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

export function resolvePendingApprovalResolver(
  runtime: ListenerRuntime,
  response: ControlResponseBody,
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
  pending.resolve(response);
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
}

export function requestApprovalOverWS(
  runtime: ListenerRuntime,
  socket: WebSocket,
  requestId: string,
  controlRequest: ControlRequest,
): Promise<ControlResponseBody> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket not open"));
  }

  return new Promise<ControlResponseBody>((resolve, reject) => {
    runtime.pendingApprovalResolvers.set(requestId, {
      resolve,
      reject,
      controlRequest,
    });
    try {
      sendControlMessageOverWebSocket(socket, controlRequest);
    } catch (error) {
      runtime.pendingApprovalResolvers.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function recoverPendingApprovals(
  runtime: ListenerRuntime,
  socket: WebSocket,
  msg: RecoverPendingApprovalsMessage,
): Promise<void> {
  console.debug(
    "[listener] recover_pending_approvals received",
    JSON.stringify({
      agentId: msg.agentId,
      conversationId: msg.conversationId ?? null,
      isProcessing: runtime.isProcessing,
      isRecovering: runtime.isRecoveringApprovals,
      batchMapSize: runtime.pendingApprovalBatchByToolCallId.size,
    }),
  );

  if (runtime.isProcessing || runtime.isRecoveringApprovals) {
    return;
  }

  runtime.isRecoveringApprovals = true;
  try {
    const agentId = msg.agentId;
    if (!agentId) {
      return;
    }

    const requestedConversationId = msg.conversationId || undefined;
    const conversationId = requestedConversationId ?? "default";
    const recoveryAgentId = normalizeCwdAgentId(agentId);
    const recoveryWorkingDirectory =
      runtime.activeAgentId === recoveryAgentId &&
      runtime.activeConversationId === conversationId &&
      runtime.activeWorkingDirectory
        ? runtime.activeWorkingDirectory
        : getConversationWorkingDirectory(
            runtime,
            recoveryAgentId,
            conversationId,
          );

    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);

    let resumeData: Awaited<ReturnType<typeof getResumeData>>;
    try {
      resumeData = await getResumeData(client, agent, requestedConversationId, {
        includeMessageHistory: false,
      });
    } catch (error) {
      if (
        error instanceof APIError &&
        (error.status === 404 || error.status === 422)
      ) {
        return;
      }
      throw error;
    }

    const pendingApprovals = resumeData.pendingApprovals || [];
    if (pendingApprovals.length === 0) {
      return;
    }

    const recoveryBatchId = resolveRecoveryBatchId(runtime, pendingApprovals);
    if (!recoveryBatchId) {
      emitToWS(socket, {
        type: "error",
        message:
          "Unable to recover pending approvals: ambiguous batch correlation",
        stop_reason: "error",
        session_id: runtime.sessionId,
        uuid: `error-${crypto.randomUUID()}`,
        agent_id: agentId,
        conversation_id: conversationId,
      });
      runtime.lastStopReason = "requires_approval";
      return;
    }

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

    const { autoAllowed, autoDenied, needsUserInput } = await classifyApprovals(
      pendingApprovals,
      {
        alwaysRequiresUserInput: isInteractiveApprovalTool,
        treatAskAsDeny: false,
        requireArgsForAutoApprove: true,
        workingDirectory: recoveryWorkingDirectory,
      },
    );

    for (const ac of autoAllowed) {
      emitToWS(socket, {
        type: "auto_approval",
        tool_call: {
          name: ac.approval.toolName,
          tool_call_id: ac.approval.toolCallId,
          arguments: ac.approval.toolArgs,
        },
        reason: ac.permission.reason || "auto-approved",
        matched_rule:
          "matchedRule" in ac.permission && ac.permission.matchedRule
            ? ac.permission.matchedRule
            : "auto-approved",
        session_id: runtime.sessionId,
        uuid: `auto-approval-${ac.approval.toolCallId}`,
        agent_id: agentId,
        conversation_id: conversationId,
      } as AutoApprovalMessage);
    }

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

    if (needsUserInput.length > 0) {
      // Reflect approval-wait state in runtime snapshot while control
      // requests are pending, so state_response queries see
      // requires_approval even during the WS round-trip.
      runtime.lastStopReason = "requires_approval";

      for (const ac of needsUserInput) {
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
          agent_id: agentId,
          conversation_id: conversationId,
        };

        const responseBody = await requestApprovalOverWS(
          runtime,
          socket,
          requestId,
          controlRequest,
        );

        if (responseBody.subtype === "success") {
          const response = responseBody.response as
            | CanUseToolResponse
            | undefined;
          if (response?.behavior === "allow") {
            const finalApproval = response.updatedInput
              ? {
                  ...ac.approval,
                  toolArgs: JSON.stringify(response.updatedInput),
                }
              : ac.approval;
            decisions.push({ type: "approve", approval: finalApproval });

            emitToWS(socket, {
              type: "auto_approval",
              tool_call: {
                name: finalApproval.toolName,
                tool_call_id: finalApproval.toolCallId,
                arguments: finalApproval.toolArgs,
              },
              reason: "Approved via WebSocket",
              matched_rule: "canUseTool callback",
              session_id: runtime.sessionId,
              uuid: `auto-approval-${ac.approval.toolCallId}`,
              agent_id: agentId,
              conversation_id: conversationId,
            } as AutoApprovalMessage);
          } else {
            decisions.push({
              type: "deny",
              approval: ac.approval,
              reason: response?.message || "Denied via WebSocket",
            });
          }
        } else {
          decisions.push({
            type: "deny",
            approval: ac.approval,
            reason:
              responseBody.subtype === "error"
                ? responseBody.error
                : "Unknown error",
          });
        }
      }
    }

    if (decisions.length === 0) {
      runtime.lastStopReason = "requires_approval";
      return;
    }

    const executionResults = await executeApprovalBatch(decisions, undefined, {
      workingDirectory: recoveryWorkingDirectory,
    });
    clearPendingApprovalBatchIds(
      runtime,
      decisions.map((decision) => decision.approval),
    );

    await handleIncomingMessage(
      {
        type: "message",
        agentId,
        conversationId,
        messages: [
          {
            type: "approval",
            approvals: executionResults,
          },
        ],
      },
      socket,
      runtime,
      undefined,
      undefined,
      recoveryBatchId,
    );
  } finally {
    runtime.isRecoveringApprovals = false;
  }
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

    // Send current mode state to cloud for UI sync
    sendClientMessage(socket, {
      type: "mode_changed",
      mode: permissionMode.getMode(),
      success: true,
    });

    runtime.heartbeatInterval = setInterval(() => {
      sendClientMessage(socket, { type: "ping" });
    }, 30000);
  });

  socket.on("message", (data: WebSocket.RawData) => {
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
    if (process.env.DEBUG) {
      console.log(
        `[Listen] Received message: ${JSON.stringify(parsed, null, 2)}`,
      );
    }

    if (!parsed) {
      return;
    }

    if (parsed.type === "control_response") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }
      if (resolvePendingApprovalResolver(runtime, parsed.response)) {
        scheduleQueuePump(runtime, socket, opts);
      }
      return;
    }

    // Handle status updates from cloud (response to ping)
    if (parsed.type === "status") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      // Update runtime state from cloud's view
      // Only update lastStopReason if we're not currently processing
      if (!runtime.isProcessing && parsed.lastStopReason !== undefined) {
        runtime.lastStopReason = parsed.lastStopReason;
      }
      return;
    }

    // Handle mode change messages immediately (not queued)
    if (parsed.type === "mode_change") {
      handleModeChange(parsed, socket);
      return;
    }

    if (parsed.type === "change_cwd") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      void handleCwdChange(parsed, socket, runtime);
      return;
    }

    if (parsed.type === "list_folders_in_directory") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      void handleListFoldersInDirectory(parsed, socket, runtime);
      return;
    }

    // Handle status request from cloud (immediate response)
    if (parsed.type === "get_status") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      sendClientMessage(socket, {
        type: "status_response",
        currentMode: permissionMode.getMode(),
        lastStopReason: runtime.lastStopReason,
        isProcessing: runtime.isProcessing,
      });
      return;
    }

    if (parsed.type === "cancel_run") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      const requestId =
        typeof parsed.request_id === "string" && parsed.request_id.length > 0
          ? parsed.request_id
          : `cancel-${crypto.randomUUID()}`;
      const requestedRunId =
        typeof parsed.run_id === "string" ? parsed.run_id : runtime.activeRunId;
      const hasPendingApprovals = runtime.pendingApprovalResolvers.size > 0;
      const hasActiveTurn = runtime.isProcessing;

      if (!hasActiveTurn && !hasPendingApprovals) {
        emitCancelAck(socket, runtime, {
          requestId,
          accepted: false,
          reason: "no_active_turn",
          runId: requestedRunId,
        });
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
      if (hasPendingApprovals) {
        rejectPendingApprovalResolvers(runtime, "Cancelled by user");
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

      emitCancelAck(socket, runtime, {
        requestId,
        accepted: true,
        runId: requestedRunId,
      });
      scheduleQueuePump(runtime, socket, opts);
      return;
    }

    if (parsed.type === "get_state") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }
      const requestedConversationId = normalizeConversationId(
        parsed.conversationId,
      );
      const requestedAgentId = normalizeCwdAgentId(parsed.agentId);

      // If we're blocked on an approval callback, don't queue behind the
      // pending turn; respond immediately so refreshed clients can render the
      // approval card needed to unblock execution.
      if (runtime.pendingApprovalResolvers.size > 0) {
        sendStateSnapshot(
          socket,
          runtime,
          requestedAgentId,
          requestedConversationId,
        );
        return;
      }

      // Serialize snapshot generation with the same message queue used for
      // message processing so reconnect snapshots cannot race in-flight turns.
      runtime.messageQueue = runtime.messageQueue
        .then(async () => {
          if (runtime !== activeRuntime || runtime.intentionallyClosed) {
            return;
          }

          sendStateSnapshot(
            socket,
            runtime,
            requestedAgentId,
            requestedConversationId,
          );
        })
        .catch((error: unknown) => {
          if (process.env.DEBUG) {
            console.error("[Listen] Error handling queued get_state:", error);
          }
        });
      return;
    }

    if (parsed.type === "recover_pending_approvals") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      // Serialize recovery with normal message handling to avoid concurrent
      // handleIncomingMessage execution when user messages arrive concurrently.
      runtime.messageQueue = runtime.messageQueue
        .then(async () => {
          try {
            if (runtime !== activeRuntime || runtime.intentionallyClosed) {
              return;
            }

            await recoverPendingApprovals(runtime, socket, parsed);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            emitToWS(socket, {
              type: "error",
              message: `Pending approval recovery failed: ${errorMessage}`,
              stop_reason: "error",
              session_id: runtime.sessionId,
              uuid: `error-${crypto.randomUUID()}`,
              agent_id: runtime.activeAgentId ?? undefined,
              conversation_id: runtime.activeConversationId ?? undefined,
            });
          } finally {
            scheduleQueuePump(runtime, socket, opts);
          }
        })
        .catch((error: unknown) => {
          if (process.env.DEBUG) {
            console.error(
              "[Listen] Error handling queued pending approval recovery:",
              error,
            );
          }
        });
      return;
    }

    // Handle incoming messages (queued for sequential processing)
    if (parsed.type === "message") {
      const hasApprovalPayload = parsed.messages.some(
        (payload): payload is ApprovalCreate =>
          "type" in payload && payload.type === "approval",
      );
      if (hasApprovalPayload) {
        emitToWS(socket, {
          type: "error",
          message:
            "Protocol violation: device websocket no longer accepts approval payloads inside message frames. Send control_response instead.",
          stop_reason: "error",
          session_id: runtime.sessionId,
          uuid: `error-${crypto.randomUUID()}`,
          agent_id: runtime.activeAgentId ?? undefined,
          conversation_id: runtime.activeConversationId ?? undefined,
        });
        return;
      }

      if (shouldQueueInboundMessage(parsed)) {
        const firstUserPayload = parsed.messages.find(
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
            agentId: parsed.agentId ?? undefined,
            conversationId: parsed.conversationId || "default",
          } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
          if (enqueuedItem) {
            runtime.queuedMessagesByItemId.set(enqueuedItem.id, parsed);
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
            parsed,
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
            console.error("[Listen] Error handling queued message:", error);
          }
          opts.onStatusChange?.("idle", opts.connectionId);
          scheduleQueuePump(runtime, socket, opts);
        });
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

    // Single authoritative queue_cleared emission for all close paths
    // (intentional and unintentional). Must fire before early returns.
    runtime.queuedMessagesByItemId.clear();
    runtime.queueRuntime.clear("shutdown");

    if (process.env.DEBUG) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    clearRuntimeTimers(runtime);
    runtime.socket = null;
    rejectPendingApprovalResolvers(runtime, "WebSocket disconnected");

    if (runtime.intentionallyClosed) {
      opts.onDisconnected();
      return;
    }

    // 1008: Environment not found - need to re-register
    if (code === 1008) {
      if (process.env.DEBUG) {
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
    if (process.env.DEBUG) {
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
  const msgStartTime = performance.now();
  let msgTurnCount = 0;
  const msgRunIds: string[] = [];
  let postStopApprovalRecoveryRetries = 0;

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

  try {
    if (!agentId) {
      runtime.isProcessing = false;
      clearActiveRunState(runtime);
      return;
    }

    if (process.env.DEBUG) {
      console.log(
        `[Listen] Handling message: agentId=${agentId}, requestedConversationId=${requestedConversationId}, conversationId=${conversationId}`,
      );
    }

    if (connectionId) {
      onStatusChange?.("processing", connectionId);
    }

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

    messagesToSend.push(...msg.messages);

    const firstMessage = msg.messages[0];
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
    const sendOptions: Parameters<typeof sendMessageStream>[2] = {
      agentId,
      streamTokens: true,
      background: true,
      workingDirectory: turnWorkingDirectory,
      ...(queuedInterruptedToolCallIds.length > 0
        ? {
            approvalNormalization: {
              interruptedToolCallIds: queuedInterruptedToolCallIds,
            },
          }
        : {}),
    };

    let stream = await sendMessageStreamWithRetry(
      conversationId,
      currentInput,
      sendOptions,
      socket,
      runtime,
      runtime.activeAbortController.signal,
    );

    turnToolContextId = getStreamToolContextId(
      stream as Stream<LettaStreamingResponse>,
    );
    let runIdSent = false;
    let runId: string | undefined;
    const buffers = createBuffers(agentId);

    // Approval loop: continue until end_turn or error
    // eslint-disable-next-line no-constant-condition
    while (true) {
      msgTurnCount++;
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
              sendClientMessage(socket, {
                type: "run_started",
                runId: maybeRunId,
                batch_id: dequeuedBatchId,
                agent_id: agentId,
                conversation_id: conversationId,
              });
            }
          }

          // Emit in-stream errors
          if (errorInfo) {
            latestErrorText = errorInfo.message || latestErrorText;
            emitToWS(socket, {
              type: "error",
              message: errorInfo.message || "Stream error",
              stop_reason: (errorInfo.error_type as StopReasonType) || "error",
              run_id: runId || errorInfo.run_id,
              session_id: runtime.sessionId,
              uuid: `error-${crypto.randomUUID()}`,
              agent_id: agentId,
              conversation_id: conversationId,
            });
          }

          // Emit chunk as MessageWire for protocol consumers
          if (shouldOutput) {
            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            const normalizedChunk = normalizeToolReturnWireMessage(
              chunk as unknown as Record<string, unknown>,
            );
            if (normalizedChunk) {
              emitToWS(socket, {
                ...normalizedChunk,
                type: "message",
                session_id: runtime.sessionId,
                uuid:
                  chunkWithIds.otid || chunkWithIds.id || crypto.randomUUID(),
                agent_id: agentId,
                conversation_id: conversationId,
              } as unknown as MessageWire);
            }
          }

          return undefined;
        },
      );

      const stopReason = result.stopReason;
      const approvals = result.approvals || [];

      // Case 1: Turn ended normally
      if (stopReason === "end_turn") {
        runtime.lastStopReason = "end_turn";
        runtime.isProcessing = false;
        clearActiveRunState(runtime);

        emitTurnResult(socket, runtime, {
          subtype: "success",
          agentId,
          conversationId,
          durationMs: performance.now() - msgStartTime,
          numTurns: msgTurnCount,
          runIds: msgRunIds,
        });
        break;
      }

      // Case 2: Explicit cancellation
      if (stopReason === "cancelled") {
        runtime.lastStopReason = "cancelled";
        runtime.isProcessing = false;
        clearActiveRunState(runtime);

        emitTurnResult(socket, runtime, {
          subtype: "interrupted",
          agentId,
          conversationId,
          durationMs: performance.now() - msgStartTime,
          numTurns: msgTurnCount,
          runIds: msgRunIds,
          stopReason: "cancelled",
        });
        break;
      }

      // Case 3: Error (or cancel-induced error)
      if (stopReason !== "requires_approval") {
        const errorDetail = await fetchRunErrorDetail(
          runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
        ).catch(() => null);

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
          emitToWS(socket, {
            type: "recovery",
            recovery_type: "approval_pending",
            message:
              "Recovering from stale approval conflict after interrupted/reconnected turn",
            run_id: runId || msgRunIds[msgRunIds.length - 1] || undefined,
            session_id: runtime.sessionId,
            uuid: `recovery-${crypto.randomUUID()}`,
            agent_id: agentId,
            conversation_id: conversationId,
          } as RecoveryMessage);

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

          stream = await sendMessageStreamWithRetry(
            conversationId,
            currentInput,
            sendOptions,
            socket,
            runtime,
            runtime.activeAbortController.signal,
          );
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
          clearActiveRunState(runtime);

          emitTurnResult(socket, runtime, {
            subtype: "interrupted",
            agentId,
            conversationId,
            durationMs: performance.now() - msgStartTime,
            numTurns: msgTurnCount,
            runIds: msgRunIds,
            stopReason: "cancelled",
          });
          break;
        }

        runtime.lastStopReason = effectiveStopReason;
        runtime.isProcessing = false;
        clearActiveRunState(runtime);

        const errorMessage =
          errorDetail || `Unexpected stop reason: ${stopReason}`;

        emitToWS(socket, {
          type: "error",
          message: errorMessage,
          stop_reason: effectiveStopReason,
          run_id: runId,
          session_id: runtime.sessionId,
          uuid: `error-${crypto.randomUUID()}`,
          agent_id: agentId,
          conversation_id: conversationId,
        });
        emitTurnResult(socket, runtime, {
          subtype: "error",
          agentId,
          conversationId,
          durationMs: performance.now() - msgStartTime,
          numTurns: msgTurnCount,
          runIds: msgRunIds,
          stopReason: effectiveStopReason,
        });
        break;
      }

      // Case 4: Requires approval - classify and handle based on permission mode
      if (approvals.length === 0) {
        // Unexpected: requires_approval but no approvals
        runtime.lastStopReason = "error";
        runtime.isProcessing = false;
        clearActiveRunState(runtime);

        emitToWS(socket, {
          type: "error",
          message: "requires_approval stop returned no approvals",
          stop_reason: "error",
          session_id: runtime.sessionId,
          uuid: `error-${crypto.randomUUID()}`,
          agent_id: agentId,
          conversation_id: conversationId,
        });
        emitTurnResult(socket, runtime, {
          subtype: "error",
          agentId,
          conversationId,
          durationMs: performance.now() - msgStartTime,
          numTurns: msgTurnCount,
          runIds: msgRunIds,
          stopReason: "error",
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

      // Emit auto-approval events for auto-allowed tools
      for (const ac of autoAllowed) {
        emitToWS(socket, {
          type: "auto_approval",
          tool_call: {
            name: ac.approval.toolName,
            tool_call_id: ac.approval.toolCallId,
            arguments: ac.approval.toolArgs,
          },
          reason: ac.permission.reason || "auto-approved",
          matched_rule:
            "matchedRule" in ac.permission && ac.permission.matchedRule
              ? ac.permission.matchedRule
              : "auto-approved",
          session_id: runtime.sessionId,
          uuid: `auto-approval-${ac.approval.toolCallId}`,
          agent_id: agentId,
          conversation_id: conversationId,
        } as AutoApprovalMessage);
      }

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

          if (responseBody.subtype === "success") {
            const response = responseBody.response as
              | CanUseToolResponse
              | undefined;
            if (response?.behavior === "allow") {
              const finalApproval = response.updatedInput
                ? {
                    ...ac.approval,
                    toolArgs: JSON.stringify(response.updatedInput),
                  }
                : ac.approval;
              decisions.push({ type: "approve", approval: finalApproval });

              // Emit auto-approval event for WS-callback-approved tool
              emitToWS(socket, {
                type: "auto_approval",
                tool_call: {
                  name: finalApproval.toolName,
                  tool_call_id: finalApproval.toolCallId,
                  arguments: finalApproval.toolArgs,
                },
                reason: "Approved via WebSocket",
                matched_rule: "canUseTool callback",
                session_id: runtime.sessionId,
                uuid: `auto-approval-${ac.approval.toolCallId}`,
                agent_id: agentId,
                conversation_id: conversationId,
              } as AutoApprovalMessage);
            } else {
              decisions.push({
                type: "deny",
                approval: ac.approval,
                reason: response?.message || "Denied via WebSocket",
              });
            }
          } else {
            decisions.push({
              type: "deny",
              approval: ac.approval,
              reason:
                responseBody.subtype === "error"
                  ? responseBody.error
                  : "Unknown error",
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
      clearPendingApprovalBatchIds(
        runtime,
        decisions.map((decision) => decision.approval),
      );

      // Create fresh approval stream for next iteration
      currentInput = [
        {
          type: "approval",
          approvals: persistedExecutionResults,
        },
      ];
      stream = await sendMessageStreamWithRetry(
        conversationId,
        currentInput,
        sendOptions,
        socket,
        runtime,
        runtime.activeAbortController.signal,
      );

      // Results were successfully submitted to the backend — clear both so a
      // cancel during the subsequent stream drain won't queue already-sent
      // results (Path A) or re-deny already-resolved tool calls (Path B).
      lastExecutionResults = null;
      lastExecutingToolCallIds = [];
      lastNeedsUserInputToolCallIds = [];
      runtime.activeExecutingToolCallIds = [];

      turnToolContextId = getStreamToolContextId(
        stream as Stream<LettaStreamingResponse>,
      );
    }
  } catch (error) {
    if (runtime.cancelRequested) {
      // Queue interrupted tool-call resolutions for the next message turn.
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
        emitInterruptToolReturnMessage(
          socket,
          runtime,
          approvalsForEmission,
          runtime.activeRunId || msgRunIds[msgRunIds.length - 1] || undefined,
        );
      }

      runtime.lastStopReason = "cancelled";
      runtime.isProcessing = false;
      clearActiveRunState(runtime);

      emitTurnResult(socket, runtime, {
        subtype: "interrupted",
        agentId: agentId || "",
        conversationId,
        durationMs: performance.now() - msgStartTime,
        numTurns: msgTurnCount,
        runIds: msgRunIds,
        stopReason: "cancelled",
      });
      return;
    }

    runtime.lastStopReason = "error";
    runtime.isProcessing = false;
    clearActiveRunState(runtime);

    // If no run_started was ever sent, the initial POST failed (e.g. 429, 402).
    // Emit run_request_error so the web UI can correlate with the optimistic run.
    if (msgRunIds.length === 0) {
      const errorPayload: RunRequestErrorMessage["error"] = {
        message: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof APIError) {
        errorPayload.status = error.status;
        if (error.error && typeof error.error === "object") {
          errorPayload.body = error.error as Record<string, unknown>;
        }
      }
      sendClientMessage(socket, {
        type: "run_request_error",
        error: errorPayload,
        batch_id: dequeuedBatchId,
        agent_id: agentId,
        conversation_id: conversationId,
      });
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    emitToWS(socket, {
      type: "error",
      message: errorMessage,
      stop_reason: "error",
      session_id: runtime.sessionId,
      uuid: `error-${crypto.randomUUID()}`,
      agent_id: agentId || undefined,
      conversation_id: conversationId,
    });
    emitTurnResult(socket, runtime, {
      subtype: "error",
      agentId: agentId || "",
      conversationId,
      durationMs: performance.now() - msgStartTime,
      numTurns: msgTurnCount,
      runIds: msgRunIds,
      stopReason: "error",
    });

    if (process.env.DEBUG) {
      console.error("[Listen] Error handling message:", error);
    }
  } finally {
    runtime.activeAbortController = null;
    runtime.cancelRequested = false;
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
  buildStateResponse,
  handleCwdChange,
  emitToWS,
  emitCancelAck,
  getConversationWorkingDirectory,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolveRecoveryBatchId,
  clearPendingApprovalBatchIds,
  populateInterruptQueue,
  setConversationWorkingDirectory,
  consumeInterruptQueue,
  extractInterruptToolReturns,
  emitInterruptToolReturnMessage,
  getInterruptApprovalsForEmission,
  normalizeToolReturnWireMessage,
  normalizeExecutionResultsForInterruptParity,
  shouldAttemptPostStopApprovalRecovery,
};
