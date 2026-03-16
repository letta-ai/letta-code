/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import { getClient } from "../../agent/client";
import { generatePlanFilePath } from "../../cli/helpers/planName";
import { INTERRUPTED_BY_USER } from "../../constants";
import { permissionMode } from "../../permissions/mode";
import { type DequeuedBatch, QueueRuntime } from "../../queue/queueRuntime";
import { createSharedReminderState } from "../../reminders/state";
import { settingsManager } from "../../settings-manager";
import { loadTools } from "../../tools/manager";
import { isDebugEnabled } from "../../utils/debug";
import { killAllTerminals } from "../terminalHandler";
import {
  clearPendingApprovalBatchIds,
  rejectPendingApprovalResolvers,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolvePendingApprovalResolver,
  resolveRecoveryBatchId,
} from "./approval";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_DURATION_MS,
} from "./constants";
import {
  getConversationWorkingDirectory,
  loadPersistedCwdMap,
  setConversationWorkingDirectory,
} from "./cwd";
import {
  consumeInterruptQueue,
  emitInterruptToolReturnMessage,
  extractInterruptToolReturns,
  getInterruptApprovalsForEmission,
  normalizeExecutionResultsForInterruptParity,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
  stashRecoveredApprovalInterrupts,
} from "./interrupts";
import { parseServerMessage } from "./protocol-inbound";
import {
  buildDeviceStatus,
  buildLoopStatus,
  buildQueueSnapshot,
  emitDeviceStatusUpdate,
  emitInterruptedStatusDelta,
  emitLoopErrorDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitStateSync,
  scheduleQueueEmit,
  setLoopStatus,
} from "./protocol-outbound";
import {
  getQueueItemScope,
  getQueueItemsScope,
  normalizeInboundMessages,
  normalizeMessageContentImages,
  scheduleQueuePump,
  shouldQueueInboundMessage,
} from "./queue";
import {
  getApprovalContinuationRecoveryDisposition,
  recoverApprovalStateForSync,
  resolveRecoveredApprovalResponse,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery";
import {
  clearRecoveredApprovalStateForScope,
  clearRuntimeTimers,
  getActiveRuntime,
  getPendingControlRequestCount,
  getRecoveredApprovalStateForScope,
  safeEmitWsEvent,
  setActiveRuntime,
} from "./runtime";
import {
  normalizeConversationId,
  normalizeCwdAgentId,
  resolveRuntimeScope,
} from "./scope";
import { markAwaitingAcceptedApprovalContinuationRunId } from "./send";
import { handleIncomingMessage } from "./turn";
import type {
  ChangeCwdMessage,
  IncomingMessage,
  ListenerRuntime,
  ModeChangePayload,
  StartListenerOptions,
} from "./types";

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

/**
 * Start the listener WebSocket client with automatic retry.
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Replace any existing runtime without stale callback leakage.
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = opts.onWsEvent;
  runtime.connectionId = opts.connectionId;
  runtime.connectionName = opts.connectionName;
  setActiveRuntime(runtime);

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
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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
    if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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
  const processQueuedTurn = async (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ): Promise<void> => {
    await handleIncomingMessage(
      queuedTurn,
      socket,
      runtime,
      opts.onStatusChange,
      opts.connectionId,
      dequeuedBatch.batchId,
    );
  };

  socket.on("open", () => {
    if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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
      if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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
      if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
        console.log(`[Listen V2] Dropping input: runtime mismatch or closed`);
        return;
      }

      if (parsed.payload.kind === "approval_response") {
        if (resolvePendingApprovalResolver(runtime, parsed.payload)) {
          scheduleQueuePump(runtime, socket, opts, processQueuedTurn);
          return;
        }
        if (
          await resolveRecoveredApprovalResponse(
            runtime,
            socket,
            parsed.payload,
            handleIncomingMessage,
            {
              onStatusChange: opts.onStatusChange,
              connectionId: opts.connectionId,
            },
          )
        ) {
          scheduleQueuePump(runtime, socket, opts, processQueuedTurn);
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
        scheduleQueuePump(runtime, socket, opts, processQueuedTurn);
        return;
      }

      runtime.messageQueue = runtime.messageQueue
        .then(async () => {
          if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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
          scheduleQueuePump(runtime, socket, opts, processQueuedTurn);
        })
        .catch((error: unknown) => {
          if (process.env.DEBUG) {
            console.error("[Listen] Error handling queued input:", error);
          }
          opts.onStatusChange?.("idle", opts.connectionId);
          scheduleQueuePump(runtime, socket, opts, processQueuedTurn);
        });
      return;
    }

    if (parsed.type === "change_device_state") {
      if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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
      if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
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

      scheduleQueuePump(runtime, socket, opts, processQueuedTurn);
      return;
    }
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (runtime !== getActiveRuntime()) {
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
 * Check if listener is currently active.
 */
export function isListenerActive(): boolean {
  const runtime = getActiveRuntime();
  return runtime !== null && runtime.socket !== null;
}

/**
 * Stop the active listener connection.
 */
export function stopListenerClient(): void {
  const runtime = getActiveRuntime();
  if (!runtime) {
    return;
  }
  setActiveRuntime(null);
  stopRuntime(runtime, true);
}

export {
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "./approval";
export { parseServerMessage } from "./protocol-inbound";
export { emitInterruptedStatusDelta } from "./protocol-outbound";

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
