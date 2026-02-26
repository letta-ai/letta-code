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
  RecoveryMessage,
  RetryMessage,
  StopReasonType,
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
}

interface RunStartedMessage {
  type: "run_started";
  runId: string;
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
}

interface GetStatusMessage {
  type: "get_status";
}

interface StatusResponseMessage {
  type: "status_response";
  currentMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  lastStopReason: string | null;
  isProcessing: boolean;
}

type ServerMessage =
  | PongMessage
  | StatusMessage
  | IncomingMessage
  | ModeChangeMessage
  | GetStatusMessage
  | WsControlResponse;
type ClientMessage =
  | PingMessage
  | ResultMessage
  | RunStartedMessage
  | ModeChangedMessage
  | StatusResponseMessage;

type PendingApprovalResolver = {
  resolve: (response: ControlResponseBody) => void;
  reject: (reason: Error) => void;
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
  /** Last stop reason from completed run */
  lastStopReason: string | null;
  /** Whether currently processing a message */
  isProcessing: boolean;
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
  return {
    socket: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    controlResponseCapable: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    lastStopReason: null,
    isProcessing: false,
  };
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
      parsed.type === "get_status"
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

function sendClientMessage(socket: WebSocket, payload: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendControlMessageOverWebSocket(
  socket: WebSocket,
  payload: ControlRequest,
): void {
  // Central hook for protocol-only outbound WS messages so future
  // filtering/mutation can be added without touching approval flow.
  socket.send(JSON.stringify(payload));
}

// ── Typed protocol event adapter ────────────────────────────────

type WsProtocolEvent =
  | MessageWire
  | AutoApprovalMessage
  | ErrorMessage
  | RetryMessage
  | RecoveryMessage
  | ProtocolResultMessage;

/**
 * Single adapter for all outbound typed protocol events.
 * Passthrough for now — provides a seam for future filtering/versioning/redacting.
 */
function emitToWS(socket: WebSocket, event: WsProtocolEvent): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
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
    runtime.pendingApprovalResolvers.set(requestId, { resolve, reject });
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
    const parsed = parseServerMessage(data);
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

    // Handle incoming messages (queued for sequential processing)
    if (parsed.type === "message") {
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

  try {
    // Latch capability: once seen, always use blocking path (strict check to avoid truthy strings)
    if (msg.supportsControlResponse === true) {
      runtime.controlResponseCapable = true;
    }

    if (!agentId) {
      runtime.isProcessing = false;
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
        if (!runtime.controlResponseCapable) {
          // Legacy path: break out, let cloud re-enter with ApprovalCreate
          runtime.lastStopReason = "requires_approval";
          runtime.isProcessing = false;

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
