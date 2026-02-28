/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
  ToolReturn,
} from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import {
  type ApprovalDecision,
  type ApprovalResult,
  executeApprovalBatch,
} from "../agent/approval-execution";
import { getResumeData } from "../agent/check-approval";
import { getClient } from "../agent/client";
import { getStreamToolContextId, sendMessageStream } from "../agent/message";
import {
  extractConflictDetail,
  getPreStreamErrorAction,
  parseRetryAfterHeaderMs,
} from "../agent/turn-recovery-policy";
import { createBuffers } from "../cli/helpers/accumulator";
import { classifyApprovals } from "../cli/helpers/approvalClassification";
import { generatePlanFilePath } from "../cli/helpers/planName";
import { drainStreamWithResume } from "../cli/helpers/stream";
import { computeDiffPreviews } from "../helpers/diffPreview";
import { permissionMode } from "../permissions/mode";
import { type QueueItem, QueueRuntime } from "../queue/queueRuntime";
import { settingsManager } from "../settings-manager";
import { isInteractiveApprovalTool } from "../tools/interactivePolicy";
import { loadTools } from "../tools/manager";
import type {
  AutoApprovalMessage,
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
  messages: Array<MessageCreate | ApprovalCreate>;
  /** Cloud sets this when it supports can_use_tool / control_response protocol. */
  supportsControlResponse?: boolean;
}

interface ResultMessage {
  type: "result";
  success: boolean;
  stopReason?: string;
  event_seq?: number;
  session_id?: string;
}

interface RunStartedMessage {
  type: "run_started";
  runId: string;
  event_seq?: number;
  session_id?: string;
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
  queue: {
    queue_len: number;
    pending_turns: number;
    items: Array<{
      id: string;
      kind: string;
      source: string;
      content: unknown;
      enqueued_at: string;
    }>;
  };
  event_seq?: number;
}

type ServerMessage =
  | PongMessage
  | StatusMessage
  | IncomingMessage
  | ModeChangeMessage
  | GetStatusMessage
  | GetStateMessage
  | RecoverPendingApprovalsMessage
  | WsControlResponse;
type ClientMessage =
  | PingMessage
  | ResultMessage
  | RunStartedMessage
  | ModeChangedMessage
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
  /** Latched once supportsControlResponse is seen on any message. */
  controlResponseCapable: boolean;
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
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  /** Queue lifecycle tracking — parallel tracking layer, does not affect message processing. */
  queueRuntime: QueueRuntime;
  /** Count of turns currently queued or in-flight in the promise chain. Incremented
   *  synchronously on message arrival (before .then()) to avoid async scheduling races. */
  pendingTurns: number;
  /** Optional debug hook for WS event logging. */
  onWsEvent?: StartListenerOptions["onWsEvent"];
  /** Prevent duplicate concurrent pending-approval recovery passes. */
  isRecoveringApprovals: boolean;
};

type ApprovalSlot =
  | { type: "result"; value: ApprovalResult }
  | { type: "decision" };

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

const MAX_RETRY_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

function createRuntime(): ListenerRuntime {
  const runtime: ListenerRuntime = {
    socket: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    controlResponseCapable: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    eventSeqCounter: 0,
    lastStopReason: null,
    isProcessing: false,
    activeAgentId: null,
    activeConversationId: null,
    activeRunId: null,
    activeRunStartedAt: null,
    isRecoveringApprovals: false,
    pendingTurns: 0,
    // queueRuntime assigned below — needs runtime ref in callbacks
    queueRuntime: null as unknown as QueueRuntime,
  };
  runtime.queueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => {
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          const content = item.kind === "message" ? item.content : item.text;
          emitToWS(runtime.socket, {
            type: "queue_item_enqueued",
            id: item.id,
            item_id: item.id,
            source: item.source,
            kind: item.kind,
            content,
            enqueued_at: new Date(item.enqueuedAt).toISOString(),
            queue_len: queueLen,
            session_id: runtime.sessionId,
            uuid: `q-enq-${item.id}`,
          });
        }
      },
      onDequeued: (batch) => {
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_batch_dequeued",
            batch_id: batch.batchId,
            item_ids: batch.items.map((i) => i.id),
            merged_count: batch.mergedCount,
            queue_len_after: batch.queueLenAfter,
            session_id: runtime.sessionId,
            uuid: `q-deq-${batch.batchId}`,
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
          });
        }
      },
      onCleared: (reason, clearedCount) => {
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_cleared",
            reason,
            cleared_count: clearedCount,
            session_id: runtime.sessionId,
            uuid: `q-clr-${crypto.randomUUID()}`,
          });
        }
      },
      onDropped: (item, reason, queueLen) => {
        if (runtime.socket?.readyState === WebSocket.OPEN) {
          emitToWS(runtime.socket, {
            type: "queue_item_dropped",
            id: item.id,
            item_id: item.id,
            reason,
            queue_len: queueLen,
            session_id: runtime.sessionId,
            uuid: `q-drp-${item.id}`,
          });
        }
      },
    },
  });
  return runtime;
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
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = null;
}

function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  runtime.intentionallyClosed = true;
  clearRuntimeTimers(runtime);
  rejectPendingApprovalResolvers(runtime, "Listener runtime stopped");

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

function buildStateResponse(
  runtime: ListenerRuntime,
  stateSeq: number,
): StateResponseMessage {
  const queueItems = runtime.queueRuntime.items.map((item) => ({
    id: item.id,
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
    mode: permissionMode.getMode(),
    is_processing: runtime.isProcessing,
    last_stop_reason: runtime.lastStopReason,
    control_response_capable: runtime.controlResponseCapable,
    active_run: {
      run_id: runtime.activeRunId,
      agent_id: runtime.activeAgentId,
      conversation_id: runtime.activeConversationId,
      started_at: runtime.activeRunStartedAt,
    },
    pending_control_requests: pendingControlRequests,
    queue: {
      queue_len: runtime.queueRuntime.length,
      pending_turns: runtime.pendingTurns,
      items: queueItems,
    },
  };
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
): Promise<Awaited<ReturnType<typeof sendMessageStream>>> {
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await sendMessageStream(conversationId, messages, opts);
    } catch (preStreamError) {
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
        // Listener can't auto-resolve pending approvals like headless does.
        // Rethrow — the cloud will resend with the approval.
        throw preStreamError;
      }

      if (action === "retry_transient") {
        const attempt = transientRetries + 1;
        const retryAfterMs =
          preStreamError instanceof APIError
            ? parseRetryAfterHeaderMs(
                preStreamError.headers?.get("retry-after"),
              )
            : null;
        const delayMs = retryAfterMs ?? 1000 * 2 ** (attempt - 1);
        transientRetries = attempt;

        emitToWS(socket, {
          type: "retry",
          reason: "llm_api_error",
          attempt,
          max_attempts: LLM_API_ERROR_MAX_RETRIES,
          delay_ms: delayMs,
          session_id: runtime.sessionId,
          uuid: `retry-${crypto.randomUUID()}`,
        } as RetryMessage);

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (action === "retry_conversation_busy") {
        const attempt = conversationBusyRetries + 1;
        const delayMs = 2500;
        conversationBusyRetries = attempt;

        emitToWS(socket, {
          type: "retry",
          reason: "error",
          attempt,
          max_attempts: MAX_CONVERSATION_BUSY_RETRIES,
          delay_ms: delayMs,
          session_id: runtime.sessionId,
          uuid: `retry-${crypto.randomUUID()}`,
        } as RetryMessage);

        await new Promise((resolve) => setTimeout(resolve, delayMs));
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

function buildApprovalExecutionPlan(
  approvalMessage: ApprovalCreate,
  pendingApprovals: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>,
): {
  slots: ApprovalSlot[];
  decisions: ApprovalDecision[];
} {
  const pendingByToolCallId = new Map(
    pendingApprovals.map((approval) => [approval.toolCallId, approval]),
  );

  const slots: ApprovalSlot[] = [];
  const decisions: ApprovalDecision[] = [];

  for (const approval of approvalMessage.approvals ?? []) {
    if (approval.type === "tool") {
      slots.push({ type: "result", value: approval as ToolReturn });
      continue;
    }

    if (approval.type !== "approval") {
      slots.push({
        type: "result",
        value: {
          type: "tool",
          tool_call_id: "unknown",
          tool_return: "Error: Unsupported approval payload",
          status: "error",
        },
      });
      continue;
    }

    const pending = pendingByToolCallId.get(approval.tool_call_id);

    if (approval.approve) {
      if (!pending) {
        slots.push({
          type: "result",
          value: {
            type: "tool",
            tool_call_id: approval.tool_call_id,
            tool_return: "Error: Pending approval not found",
            status: "error",
          },
        });
        continue;
      }

      decisions.push({
        type: "approve",
        approval: {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          toolArgs: pending.toolArgs || "{}",
        },
      });
      slots.push({ type: "decision" });
      continue;
    }

    decisions.push({
      type: "deny",
      approval: {
        toolCallId: approval.tool_call_id,
        toolName: pending?.toolName ?? "",
        toolArgs: pending?.toolArgs ?? "{}",
      },
      reason:
        typeof approval.reason === "string" && approval.reason.length > 0
          ? approval.reason
          : "Tool execution denied",
    });
    slots.push({ type: "decision" });
  }

  return { slots, decisions };
}

async function recoverPendingApprovals(
  runtime: ListenerRuntime,
  socket: WebSocket,
  msg: RecoverPendingApprovalsMessage,
): Promise<void> {
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
      if (!runtime.controlResponseCapable) {
        runtime.lastStopReason = "requires_approval";
        return;
      }

      for (const ac of needsUserInput) {
        const requestId = `perm-${ac.approval.toolCallId}`;
        const diffs = await computeDiffPreviews(
          ac.approval.toolName,
          ac.parsedArgs,
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

    const executionResults = await executeApprovalBatch(decisions);

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
        supportsControlResponse: runtime.controlResponseCapable,
      },
      socket,
      runtime,
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
      resolvePendingApprovalResolver(runtime, parsed.response);
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

    if (parsed.type === "get_state") {
      if (runtime !== activeRuntime || runtime.intentionallyClosed) {
        return;
      }

      // Serialize snapshot generation with the same message queue used for
      // message processing so reconnect snapshots cannot race in-flight turns.
      runtime.messageQueue = runtime.messageQueue
        .then(async () => {
          if (runtime !== activeRuntime || runtime.intentionallyClosed) {
            return;
          }

          const stateSeq = nextEventSeq(runtime);
          if (stateSeq === null) {
            return;
          }
          const stateResponse = buildStateResponse(runtime, stateSeq);
          sendClientMessage(socket, stateResponse, runtime);
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

      // Recovery requests are only sent by the modern cloud listener protocol.
      runtime.controlResponseCapable = true;

      // Serialize recovery with normal message handling to avoid concurrent
      // handleIncomingMessage execution when user messages arrive concurrently.
      runtime.pendingTurns++;
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
            });
          } finally {
            runtime.pendingTurns--;
            if (runtime.pendingTurns === 0) {
              runtime.queueRuntime.resetBlockedState();
            }
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
      // Queue lifecycle tracking: only enqueue if first payload is a
      // MessageCreate (has `content`). ApprovalCreate payloads (legacy
      // approval path) do not represent user-initiated messages.
      const firstPayload = parsed.messages.at(0);
      const isUserMessage =
        firstPayload !== undefined && "content" in firstPayload;
      if (isUserMessage) {
        runtime.queueRuntime.enqueue({
          kind: "message",
          source: "user",
          content: (firstPayload as MessageCreate).content,
        } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
        // Emit blocked on state transition when turns are already queued.
        // pendingTurns is incremented synchronously (below) before .then(),
        // so a second arrival always sees the correct count.
        if (runtime.pendingTurns > 0) {
          runtime.queueRuntime.tryDequeue("runtime_busy");
        }
      }
      // Increment synchronously before chaining to avoid scheduling races
      runtime.pendingTurns++;

      runtime.messageQueue = runtime.messageQueue
        .then(async () => {
          if (runtime !== activeRuntime || runtime.intentionallyClosed) {
            runtime.pendingTurns--;
            return;
          }

          // Signal dequeue for exactly this one turn (one message per chain cb)
          if (isUserMessage) {
            runtime.queueRuntime.consumeItems(1);
          }

          // onStatusChange("receiving") is inside try so that any throw
          // still reaches the finally and decrements pendingTurns.
          try {
            opts.onStatusChange?.("receiving", opts.connectionId);
            await handleIncomingMessage(
              parsed,
              socket,
              runtime,
              opts.onStatusChange,
              opts.connectionId,
            );
            opts.onStatusChange?.("idle", opts.connectionId);
          } finally {
            runtime.pendingTurns--;
            // Reset blocked state only when queue is fully drained
            if (runtime.pendingTurns === 0) {
              runtime.queueRuntime.resetBlockedState();
            }
          }
        })
        .catch((error: unknown) => {
          if (process.env.DEBUG) {
            console.error("[Listen] Error handling queued message:", error);
          }
          opts.onStatusChange?.("idle", opts.connectionId);
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
): Promise<void> {
  // Hoist identifiers and tracking state so they're available in catch for error-result
  const agentId = msg.agentId;
  const requestedConversationId = msg.conversationId || undefined;
  const conversationId = requestedConversationId ?? "default";
  const msgStartTime = performance.now();
  let msgTurnCount = 0;
  const msgRunIds: string[] = [];

  runtime.isProcessing = true;
  runtime.activeAgentId = agentId ?? null;
  runtime.activeConversationId = conversationId;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = null;

  try {
    // Latch capability: once seen, always use blocking path (strict check to avoid truthy strings)
    if (msg.supportsControlResponse === true) {
      runtime.controlResponseCapable = true;
    }

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

    let messagesToSend: Array<MessageCreate | ApprovalCreate> = msg.messages;
    let turnToolContextId: string | null = null;

    const firstMessage = msg.messages[0];
    const isApprovalMessage =
      firstMessage &&
      "type" in firstMessage &&
      firstMessage.type === "approval" &&
      "approvals" in firstMessage;

    if (isApprovalMessage) {
      if (runtime.controlResponseCapable && process.env.DEBUG) {
        console.warn(
          "[Listen] Protocol violation: controlResponseCapable is latched but received legacy ApprovalCreate message. " +
            "The cloud should send control_response instead. This may cause the current turn to stall.",
        );
      }
      const approvalMessage = firstMessage as ApprovalCreate;
      const client = await getClient();
      const agent = await client.agents.retrieve(agentId);
      const resumeData = await getResumeData(
        client,
        agent,
        requestedConversationId,
      );

      const { slots, decisions } = buildApprovalExecutionPlan(
        approvalMessage,
        resumeData.pendingApprovals,
      );
      const decisionResults =
        decisions.length > 0
          ? await executeApprovalBatch(decisions, undefined, {
              toolContextId: turnToolContextId ?? undefined,
            })
          : [];

      const rebuiltApprovals: ApprovalResult[] = [];
      let decisionResultIndex = 0;

      for (const slot of slots) {
        if (slot.type === "result") {
          rebuiltApprovals.push(slot.value);
          continue;
        }

        const next = decisionResults[decisionResultIndex];
        if (next) {
          rebuiltApprovals.push(next);
          decisionResultIndex++;
          continue;
        }

        rebuiltApprovals.push({
          type: "tool",
          tool_call_id: "unknown",
          tool_return: "Error: Missing approval execution result",
          status: "error",
        });
      }

      messagesToSend = [
        {
          type: "approval",
          approvals: rebuiltApprovals,
        },
      ];
    }

    let stream = await sendMessageStreamWithRetry(
      conversationId,
      messagesToSend,
      { agentId, streamTokens: true, background: true },
      socket,
      runtime,
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
      const result = await drainStreamWithResume(
        stream as Stream<LettaStreamingResponse>,
        buffers,
        () => {},
        undefined,
        undefined,
        ({ chunk, shouldOutput, errorInfo }) => {
          const maybeRunId = (chunk as { run_id?: unknown }).run_id;
          if (typeof maybeRunId === "string") {
            runId = maybeRunId;
            if (runtime.activeRunId !== maybeRunId) {
              runtime.activeRunId = maybeRunId;
              runtime.activeRunStartedAt = new Date().toISOString();
            }
            if (!runIdSent) {
              runIdSent = true;
              msgRunIds.push(maybeRunId);
              sendClientMessage(socket, {
                type: "run_started",
                runId: maybeRunId,
              });
            }
          }

          // Emit in-stream errors
          if (errorInfo) {
            emitToWS(socket, {
              type: "error",
              message: errorInfo.message || "Stream error",
              stop_reason: (errorInfo.error_type as StopReasonType) || "error",
              run_id: runId || errorInfo.run_id,
              session_id: runtime.sessionId,
              uuid: `error-${crypto.randomUUID()}`,
            });
          }

          // Emit chunk as MessageWire for protocol consumers
          if (shouldOutput) {
            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            emitToWS(socket, {
              ...chunk,
              type: "message",
              session_id: runtime.sessionId,
              uuid: chunkWithIds.otid || chunkWithIds.id || crypto.randomUUID(),
            } as MessageWire);
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

        if (runtime.controlResponseCapable) {
          emitToWS(socket, {
            type: "result",
            subtype: "success",
            agent_id: agentId,
            conversation_id: conversationId,
            duration_ms: performance.now() - msgStartTime,
            duration_api_ms: 0,
            num_turns: msgTurnCount,
            result: null,
            run_ids: msgRunIds,
            usage: null,
            session_id: runtime.sessionId,
            uuid: `result-${crypto.randomUUID()}`,
          });
        } else {
          sendClientMessage(socket, {
            type: "result",
            success: true,
            stopReason: "end_turn",
          });
        }
        break;
      }

      // Case 2: Error or cancelled
      if (stopReason !== "requires_approval") {
        runtime.lastStopReason = stopReason;
        runtime.isProcessing = false;
        clearActiveRunState(runtime);

        emitToWS(socket, {
          type: "error",
          message: `Unexpected stop reason: ${stopReason}`,
          stop_reason: (stopReason as StopReasonType) || "error",
          run_id: runId,
          session_id: runtime.sessionId,
          uuid: `error-${crypto.randomUUID()}`,
        });
        if (runtime.controlResponseCapable) {
          emitToWS(socket, {
            type: "result",
            subtype: "error",
            agent_id: agentId,
            conversation_id: conversationId,
            duration_ms: performance.now() - msgStartTime,
            duration_api_ms: 0,
            num_turns: msgTurnCount,
            result: null,
            run_ids: msgRunIds,
            usage: null,
            stop_reason: (stopReason as StopReasonType) || "error",
            session_id: runtime.sessionId,
            uuid: `result-${crypto.randomUUID()}`,
          });
        } else {
          sendClientMessage(socket, {
            type: "result",
            success: false,
            stopReason,
          });
        }
        break;
      }

      // Case 3: Requires approval - classify and handle based on permission mode
      if (approvals.length === 0) {
        // Unexpected: requires_approval but no approvals
        runtime.lastStopReason = "error";
        runtime.isProcessing = false;
        clearActiveRunState(runtime);

        sendClientMessage(socket, {
          type: "result",
          success: false,
          stopReason: "error",
        });
        break;
      }

      // Classify approvals (auto-allow, auto-deny, needs user input)
      // Don't treat "ask" as deny - cloud UI can handle approvals
      // Interactive tools (AskUserQuestion, EnterPlanMode, ExitPlanMode) always need user input
      const { autoAllowed, autoDenied, needsUserInput } =
        await classifyApprovals(approvals, {
          alwaysRequiresUserInput: isInteractiveApprovalTool,
          treatAskAsDeny: false, // Let cloud UI handle approvals
          requireArgsForAutoApprove: true,
        });

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

        if (!runtime.controlResponseCapable) {
          // Legacy path: break out, let cloud re-enter with ApprovalCreate
          runtime.isProcessing = false;
          clearActiveRunState(runtime);

          sendClientMessage(socket, {
            type: "result",
            success: false,
            stopReason: "requires_approval",
          });
          break;
        }

        // New path: blocking-in-loop via WS control protocol
        for (const ac of needsUserInput) {
          const requestId = `perm-${ac.approval.toolCallId}`;
          const diffs = await computeDiffPreviews(
            ac.approval.toolName,
            ac.parsedArgs,
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

      // Execute approved/denied tools
      const executionResults = await executeApprovalBatch(
        decisions,
        undefined,
        { toolContextId: turnToolContextId ?? undefined },
      );

      // Create fresh approval stream for next iteration
      stream = await sendMessageStreamWithRetry(
        conversationId,
        [
          {
            type: "approval",
            approvals: executionResults,
          },
        ],
        { agentId, streamTokens: true, background: true },
        socket,
        runtime,
      );
      turnToolContextId = getStreamToolContextId(
        stream as Stream<LettaStreamingResponse>,
      );
    }
  } catch (error) {
    runtime.lastStopReason = "error";
    runtime.isProcessing = false;
    clearActiveRunState(runtime);

    const errorMessage = error instanceof Error ? error.message : String(error);
    emitToWS(socket, {
      type: "error",
      message: errorMessage,
      stop_reason: "error",
      session_id: runtime.sessionId,
      uuid: `error-${crypto.randomUUID()}`,
    });
    if (runtime.controlResponseCapable) {
      emitToWS(socket, {
        type: "result",
        subtype: "error",
        agent_id: agentId || "",
        conversation_id: conversationId,
        duration_ms: performance.now() - msgStartTime,
        duration_api_ms: 0,
        num_turns: msgTurnCount,
        result: null,
        run_ids: msgRunIds,
        usage: null,
        stop_reason: "error",
        session_id: runtime.sessionId,
        uuid: `result-${crypto.randomUUID()}`,
      });
    } else {
      sendClientMessage(socket, {
        type: "result",
        success: false,
        stopReason: "error",
      });
    }

    if (process.env.DEBUG) {
      console.error("[Listen] Error handling message:", error);
    }
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
  emitToWS,
};
