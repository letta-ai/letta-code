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
import { ensureFileIndex, searchFileIndex } from "../../cli/helpers/fileIndex";
import { generatePlanFilePath } from "../../cli/helpers/planName";
import { INTERRUPTED_BY_USER } from "../../constants";
import { type DequeuedBatch, QueueRuntime } from "../../queue/queueRuntime";
import { createSharedReminderState } from "../../reminders/state";
import { settingsManager } from "../../settings-manager";
import { loadTools } from "../../tools/manager";
import type {
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
} from "../../types/protocol_v2";
import { isDebugEnabled } from "../../utils/debug";
import {
  handleTerminalInput,
  handleTerminalKill,
  handleTerminalResize,
  handleTerminalSpawn,
  killAllTerminals,
} from "../terminalHandler";
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
import {
  getConversationPermissionModeState,
  loadPersistedPermissionModeMap,
  setConversationPermissionModeState,
} from "./permissionMode";
import {
  isEnableMemfsCommand,
  isListInDirectoryCommand,
  isListMemoryCommand,
  isReadFileCommand,
  isSearchFilesCommand,
  parseServerMessage,
} from "./protocol-inbound";
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
  consumeQueuedTurn,
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
  clearConversationRuntimeState,
  clearRecoveredApprovalStateForScope,
  clearRuntimeTimers,
  emitListenerStatus,
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getListenerStatus,
  getOrCreateConversationRuntime,
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
import {
  markAwaitingAcceptedApprovalContinuationRunId,
  resolveStaleApprovals,
} from "./send";
import { handleIncomingMessage } from "./turn";
import type {
  ChangeCwdMessage,
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ModeChangePayload,
  StartListenerOptions,
} from "./types";

/**
 * Handle mode change request from cloud.
 * Stores the new mode in ListenerRuntime.permissionModeByConversation so
 * each agent/conversation is isolated and the state outlives the ephemeral
 * ConversationRuntime (which gets evicted between turns).
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
    const agentId = scope?.agent_id ?? null;
    const conversationId = scope?.conversation_id ?? "default";
    const current = getConversationPermissionModeState(
      runtime,
      agentId,
      conversationId,
    );

    const next = { ...current };

    // Track previous mode so ExitPlanMode can restore it
    if (msg.mode === "plan" && current.mode !== "plan") {
      next.modeBeforePlan = current.mode;
    }
    next.mode = msg.mode;

    // Generate plan file path when entering plan mode
    if (msg.mode === "plan" && !current.planFilePath) {
      next.planFilePath = generatePlanFilePath();
    }

    // Clear plan-related state when leaving plan mode
    if (msg.mode !== "plan") {
      next.planFilePath = null;
      next.modeBeforePlan = null;
    }

    setConversationPermissionModeState(runtime, agentId, conversationId, next);

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

function ensureConversationQueueRuntime(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
): ConversationRuntime {
  if (runtime.queueRuntime) {
    return runtime;
  }
  runtime.queueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        scheduleQueueEmit(listener, getQueueItemScope(item));
      },
      onDequeued: (batch) => {
        runtime.pendingTurns = batch.queueLenAfter;
        scheduleQueueEmit(listener, getQueueItemsScope(batch.items));
      },
      onBlocked: () => {
        scheduleQueueEmit(listener, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        });
      },
      onCleared: (_reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
        scheduleQueueEmit(listener, getQueueItemsScope(items));
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, _reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        scheduleQueueEmit(listener, getQueueItemScope(item));
        evictConversationRuntimeIfIdle(runtime);
      },
    },
  });
  return runtime;
}

function getOrCreateScopedRuntime(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationRuntime {
  return ensureConversationQueueRuntime(
    listener,
    getOrCreateConversationRuntime(listener, agentId, conversationId),
  );
}

function resolveRuntimeForApprovalRequest(
  listener: ListenerRuntime,
  requestId?: string | null,
): ConversationRuntime | null {
  if (!requestId) {
    return null;
  }
  const runtimeKey = listener.approvalRuntimeKeyByRequestId.get(requestId);
  if (!runtimeKey) {
    return null;
  }
  return listener.conversationRuntimes.get(runtimeKey) ?? null;
}

type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

async function handleApprovalResponseInput(
  listener: ListenerRuntime,
  params: {
    runtime: {
      agent_id?: string | null;
      conversation_id?: string | null;
    };
    response: ApprovalResponseBody;
    socket: WebSocket;
    opts: {
      onStatusChange?: StartListenerOptions["onStatusChange"];
      connectionId?: string;
    };
    processQueuedTurn: ProcessQueuedTurn;
  },
  deps: {
    resolveRuntimeForApprovalRequest: (
      listener: ListenerRuntime,
      requestId?: string | null,
    ) => ConversationRuntime | null;
    resolvePendingApprovalResolver: (
      runtime: ConversationRuntime,
      response: ApprovalResponseBody,
    ) => boolean;
    getOrCreateScopedRuntime: (
      listener: ListenerRuntime,
      agentId?: string | null,
      conversationId?: string | null,
    ) => ConversationRuntime;
    resolveRecoveredApprovalResponse: (
      runtime: ConversationRuntime,
      socket: WebSocket,
      response: ApprovalResponseBody,
      processTurn: typeof handleIncomingMessage,
      opts?: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      },
    ) => Promise<boolean>;
    scheduleQueuePump: (
      runtime: ConversationRuntime,
      socket: WebSocket,
      opts: StartListenerOptions,
      processQueuedTurn: ProcessQueuedTurn,
    ) => void;
  } = {
    resolveRuntimeForApprovalRequest,
    resolvePendingApprovalResolver,
    getOrCreateScopedRuntime,
    resolveRecoveredApprovalResponse,
    scheduleQueuePump,
  },
): Promise<boolean> {
  const approvalRuntime = deps.resolveRuntimeForApprovalRequest(
    listener,
    params.response.request_id,
  );
  if (
    approvalRuntime &&
    deps.resolvePendingApprovalResolver(approvalRuntime, params.response)
  ) {
    deps.scheduleQueuePump(
      approvalRuntime,
      params.socket,
      params.opts as StartListenerOptions,
      params.processQueuedTurn,
    );
    return true;
  }

  const targetRuntime =
    approvalRuntime ??
    deps.getOrCreateScopedRuntime(
      listener,
      params.runtime.agent_id,
      params.runtime.conversation_id,
    );
  if (
    await deps.resolveRecoveredApprovalResponse(
      targetRuntime,
      params.socket,
      params.response,
      handleIncomingMessage,
      {
        onStatusChange: params.opts.onStatusChange,
        connectionId: params.opts.connectionId,
      },
    )
  ) {
    deps.scheduleQueuePump(
      targetRuntime,
      params.socket,
      params.opts as StartListenerOptions,
      params.processQueuedTurn,
    );
    return true;
  }

  return false;
}

async function handleChangeDeviceStateInput(
  listener: ListenerRuntime,
  params: {
    command: ChangeDeviceStateCommand;
    socket: WebSocket;
    opts: {
      onStatusChange?: StartListenerOptions["onStatusChange"];
      connectionId?: string;
    };
    processQueuedTurn: ProcessQueuedTurn;
  },
  deps: Partial<{
    getActiveRuntime: typeof getActiveRuntime;
    getOrCreateScopedRuntime: typeof getOrCreateScopedRuntime;
    getPendingControlRequestCount: typeof getPendingControlRequestCount;
    setLoopStatus: typeof setLoopStatus;
    handleModeChange: typeof handleModeChange;
    handleCwdChange: typeof handleCwdChange;
    emitDeviceStatusUpdate: typeof emitDeviceStatusUpdate;
    scheduleQueuePump: typeof scheduleQueuePump;
  }> = {},
): Promise<boolean> {
  const resolvedDeps = {
    getActiveRuntime,
    getOrCreateScopedRuntime,
    getPendingControlRequestCount,
    setLoopStatus,
    handleModeChange,
    handleCwdChange,
    emitDeviceStatusUpdate,
    scheduleQueuePump,
    ...deps,
  };

  if (
    listener !== resolvedDeps.getActiveRuntime() ||
    listener.intentionallyClosed
  ) {
    return false;
  }

  const scope = {
    agent_id:
      params.command.payload.agent_id ??
      params.command.runtime.agent_id ??
      undefined,
    conversation_id:
      params.command.payload.conversation_id ??
      params.command.runtime.conversation_id ??
      undefined,
  };
  const scopedRuntime = resolvedDeps.getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const shouldTrackCommand =
    !scopedRuntime.isProcessing &&
    resolvedDeps.getPendingControlRequestCount(listener, scope) === 0;

  if (shouldTrackCommand) {
    resolvedDeps.setLoopStatus(scopedRuntime, "EXECUTING_COMMAND", scope);
  }

  try {
    if (params.command.payload.mode) {
      resolvedDeps.handleModeChange(
        { mode: params.command.payload.mode },
        params.socket,
        listener,
        scope,
      );
    }

    if (params.command.payload.cwd) {
      await resolvedDeps.handleCwdChange(
        {
          agentId: scope.agent_id ?? null,
          conversationId: scope.conversation_id ?? null,
          cwd: params.command.payload.cwd,
        },
        params.socket,
        scopedRuntime,
      );
    } else if (!params.command.payload.mode) {
      resolvedDeps.emitDeviceStatusUpdate(params.socket, listener, scope);
    }
  } finally {
    if (shouldTrackCommand) {
      resolvedDeps.setLoopStatus(scopedRuntime, "WAITING_ON_INPUT", scope);
      resolvedDeps.scheduleQueuePump(
        scopedRuntime,
        params.socket,
        params.opts as StartListenerOptions,
        params.processQueuedTurn,
      );
    }
  }

  return true;
}

async function handleCwdChange(
  msg: ChangeCwdMessage,
  socket: WebSocket,
  runtime: ConversationRuntime,
): Promise<void> {
  const conversationId = normalizeConversationId(msg.conversationId);
  const agentId = normalizeCwdAgentId(msg.agentId);
  const currentWorkingDirectory = getConversationWorkingDirectory(
    runtime.listener,
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
      runtime.listener,
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
  return {
    socket: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    eventSeqCounter: 0,
    lastStopReason: null,
    queueEmitScheduled: false,
    pendingQueueEmitScope: undefined,
    onWsEvent: undefined,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: loadPersistedCwdMap(),
    permissionModeByConversation: loadPersistedPermissionModeMap(),
    connectionId: null,
    connectionName: null,
    conversationRuntimes: new Map(),
    approvalRuntimeKeyByRequestId: new Map(),
    lastEmittedStatus: null,
  };
}

function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  runtime.intentionallyClosed = true;
  clearRuntimeTimers(runtime);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    rejectPendingApprovalResolvers(
      conversationRuntime,
      "Listener runtime stopped",
    );
    clearConversationRuntimeState(conversationRuntime);
    if (conversationRuntime.queueRuntime) {
      conversationRuntime.queuedMessagesByItemId.clear();
      conversationRuntime.queueRuntime.clear("shutdown");
    }
  }
  runtime.conversationRuntimes.clear();
  runtime.approvalRuntimeKeyByRequestId.clear();

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
  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ): Promise<void> => {
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      socket,
      scopedRuntime,
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

    if (runtime.conversationRuntimes.size === 0) {
      emitDeviceStatusUpdate(socket, runtime);
      emitLoopStatusUpdate(socket, runtime);
    } else {
      for (const conversationRuntime of runtime.conversationRuntimes.values()) {
        const scope = {
          agent_id: conversationRuntime.agentId,
          conversation_id: conversationRuntime.conversationId,
        };
        emitDeviceStatusUpdate(socket, conversationRuntime, scope);
        emitLoopStatusUpdate(socket, conversationRuntime, scope);
      }
    }

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
      await recoverApprovalStateForSync(
        getOrCreateScopedRuntime(
          runtime,
          parsed.runtime.agent_id,
          parsed.runtime.conversation_id,
        ),
        parsed.runtime,
      );
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
        if (
          await handleApprovalResponseInput(runtime, {
            runtime: parsed.runtime,
            response: parsed.payload,
            socket,
            opts: {
              onStatusChange: opts.onStatusChange,
              connectionId: opts.connectionId,
            },
            processQueuedTurn,
          })
        ) {
          return;
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

      const scopedRuntime = getOrCreateScopedRuntime(
        runtime,
        incoming.agentId,
        incoming.conversationId,
      );

      if (shouldQueueInboundMessage(incoming)) {
        const firstUserPayload = incoming.messages.find(
          (
            payload,
          ): payload is MessageCreate & { client_message_id?: string } =>
            "content" in payload,
        );
        if (firstUserPayload) {
          const enqueuedItem = scopedRuntime.queueRuntime.enqueue({
            kind: "message",
            source: "user",
            content: firstUserPayload.content,
            clientMessageId:
              firstUserPayload.client_message_id ??
              `cm-submit-${crypto.randomUUID()}`,
            agentId: parsed.runtime.agent_id,
            conversationId: parsed.runtime.conversation_id || "default",
          } as Parameters<typeof scopedRuntime.queueRuntime.enqueue>[0]);
          if (enqueuedItem) {
            scopedRuntime.queuedMessagesByItemId.set(enqueuedItem.id, incoming);
          }
        }
        scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
        return;
      }

      scopedRuntime.messageQueue = scopedRuntime.messageQueue
        .then(async () => {
          if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
            return;
          }
          emitListenerStatus(runtime, opts.onStatusChange, opts.connectionId);
          await handleIncomingMessage(
            incoming,
            socket,
            scopedRuntime,
            opts.onStatusChange,
            opts.connectionId,
          );
          emitListenerStatus(runtime, opts.onStatusChange, opts.connectionId);
          scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
        })
        .catch((error: unknown) => {
          if (process.env.DEBUG) {
            console.error("[Listen] Error handling queued input:", error);
          }
          emitListenerStatus(runtime, opts.onStatusChange, opts.connectionId);
          scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
        });
      return;
    }

    if (parsed.type === "change_device_state") {
      await handleChangeDeviceStateInput(runtime, {
        command: parsed,
        socket,
        opts: {
          onStatusChange: opts.onStatusChange,
          connectionId: opts.connectionId,
        },
        processQueuedTurn,
      });
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
      const scopedRuntime = getOrCreateScopedRuntime(
        runtime,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
      );
      const hasActiveTurn = scopedRuntime.isProcessing;

      if (!hasActiveTurn && !hasPendingApprovals) {
        return;
      }

      scopedRuntime.cancelRequested = true;
      // Eager interrupt capture parity with App/headless:
      // if tool execution is currently in-flight, queue explicit interrupted
      // tool results immediately at cancel time (before async catch paths).
      if (
        scopedRuntime.activeExecutingToolCallIds.length > 0 &&
        (!scopedRuntime.pendingInterruptedResults ||
          scopedRuntime.pendingInterruptedResults.length === 0)
      ) {
        scopedRuntime.pendingInterruptedResults =
          scopedRuntime.activeExecutingToolCallIds.map((toolCallId) => ({
            type: "tool",
            tool_call_id: toolCallId,
            tool_return: INTERRUPTED_BY_USER,
            status: "error",
          }));
        scopedRuntime.pendingInterruptedContext = {
          agentId: scopedRuntime.agentId || "",
          conversationId: scopedRuntime.conversationId,
          continuationEpoch: scopedRuntime.continuationEpoch,
        };
        scopedRuntime.pendingInterruptedToolCallIds = [
          ...scopedRuntime.activeExecutingToolCallIds,
        ];
      }
      if (
        scopedRuntime.activeAbortController &&
        !scopedRuntime.activeAbortController.signal.aborted
      ) {
        scopedRuntime.activeAbortController.abort();
      }
      const recoveredApprovalState = getRecoveredApprovalStateForScope(
        runtime,
        {
          agent_id: parsed.runtime.agent_id,
          conversation_id: parsed.runtime.conversation_id,
        },
      );
      if (recoveredApprovalState && !hasActiveTurn) {
        stashRecoveredApprovalInterrupts(scopedRuntime, recoveredApprovalState);
      }
      if (hasPendingApprovals) {
        rejectPendingApprovalResolvers(scopedRuntime, "Cancelled by user");
      }

      if (!hasActiveTurn && hasPendingApprovals) {
        emitInterruptedStatusDelta(socket, scopedRuntime, {
          runId: scopedRuntime.activeRunId,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
      }

      // Backend cancel parity with TUI (App.tsx:5932-5941).
      // Fire-and-forget — local cancel + queued results are the primary mechanism.
      const cancelConversationId = scopedRuntime.conversationId;
      const cancelAgentId = scopedRuntime.agentId;
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

      scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
      return;
    }

    // ── File search (no runtime scope required) ────────────────────────
    if (isSearchFilesCommand(parsed)) {
      void (async () => {
        await ensureFileIndex();
        const files = searchFileIndex({
          searchDir: ".",
          pattern: parsed.query,
          deep: true,
          maxResults: parsed.max_results ?? 5,
        });
        socket.send(
          JSON.stringify({
            type: "search_files_response",
            request_id: parsed.request_id,
            files,
            success: true,
          }),
        );
      })();
      return;
    }

    // ── Directory listing (no runtime scope required) ──────────────────
    if (isListInDirectoryCommand(parsed)) {
      void (async () => {
        try {
          const { readdir } = await import("node:fs/promises");
          const entries = await readdir(parsed.path, { withFileTypes: true });

          // Filter out OS/VCS noise before sorting
          const IGNORED_NAMES = new Set([
            ".DS_Store",
            ".git",
            ".gitignore",
            "Thumbs.db",
          ]);
          const sortedEntries = entries
            .filter((e) => !IGNORED_NAMES.has(e.name))
            .sort((a, b) => a.name.localeCompare(b.name));

          const allFolders: string[] = [];
          const allFiles: string[] = [];
          for (const e of sortedEntries) {
            if (e.isDirectory()) {
              allFolders.push(e.name);
            } else if (parsed.include_files) {
              allFiles.push(e.name);
            }
          }

          const total = allFolders.length + allFiles.length;
          const offset = parsed.offset ?? 0;
          const limit = parsed.limit ?? total;

          // Paginate over the combined [folders, files] list
          const combined = [...allFolders, ...allFiles];
          const page = combined.slice(offset, offset + limit);
          const folders = page.filter((name) => allFolders.includes(name));
          const files = page.filter((name) => allFiles.includes(name));

          const response: Record<string, unknown> = {
            type: "list_in_directory_response",
            path: parsed.path,
            folders,
            hasMore: offset + limit < total,
            total,
            success: true,
          };
          if (parsed.include_files) {
            response.files = files;
          }
          socket.send(JSON.stringify(response));
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "list_in_directory_response",
              path: parsed.path,
              folders: [],
              hasMore: false,
              success: false,
              error:
                err instanceof Error ? err.message : "Failed to list directory",
            }),
          );
        }
      })();
      return;
    }

    // ── File reading (no runtime scope required) ─────────────────────
    if (isReadFileCommand(parsed)) {
      void (async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(parsed.path, "utf-8");
          socket.send(
            JSON.stringify({
              type: "read_file_response",
              request_id: parsed.request_id,
              path: parsed.path,
              content,
              success: true,
            }),
          );
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "read_file_response",
              request_id: parsed.request_id,
              path: parsed.path,
              content: null,
              success: false,
              error: err instanceof Error ? err.message : "Failed to read file",
            }),
          );
        }
      })();
      return;
    }

    // ── Memory index (no runtime scope required) ─────────────────────
    if (isListMemoryCommand(parsed)) {
      void (async () => {
        try {
          const { getMemoryFilesystemRoot } = await import(
            "../../agent/memoryFilesystem"
          );
          const { scanMemoryFilesystem, getFileNodes, readFileContent } =
            await import("../../agent/memoryScanner");
          const { parseFrontmatter } = await import("../../utils/frontmatter");

          const { existsSync } = await import("node:fs");
          const { join } = await import("node:path");

          const memoryRoot = getMemoryFilesystemRoot(parsed.agent_id);

          // If the memory directory doesn't have a git repo, memfs
          // hasn't been initialized — tell the UI so it can show the
          // enable button instead of an empty file list.
          const memfsInitialized = existsSync(join(memoryRoot, ".git"));

          if (!memfsInitialized) {
            socket.send(
              JSON.stringify({
                type: "list_memory_response",
                request_id: parsed.request_id,
                entries: [],
                done: true,
                total: 0,
                success: true,
                memfs_initialized: false,
              }),
            );
            return;
          }

          const treeNodes = scanMemoryFilesystem(memoryRoot);
          const fileNodes = getFileNodes(treeNodes).filter((n) =>
            n.name.endsWith(".md"),
          );

          const CHUNK_SIZE = 5;
          const total = fileNodes.length;

          for (let i = 0; i < total; i += CHUNK_SIZE) {
            const chunk = fileNodes.slice(i, i + CHUNK_SIZE);
            const entries = chunk.map((node) => {
              const raw = readFileContent(node.fullPath);
              const { frontmatter, body } = parseFrontmatter(raw);
              const desc = frontmatter.description;
              return {
                relative_path: node.relativePath,
                is_system:
                  node.relativePath.startsWith("system/") ||
                  node.relativePath.startsWith("system\\"),
                description: typeof desc === "string" ? desc : null,
                content: body,
                size: body.length,
              };
            });

            const done = i + CHUNK_SIZE >= total;
            socket.send(
              JSON.stringify({
                type: "list_memory_response",
                request_id: parsed.request_id,
                entries,
                done,
                total,
                success: true,
                memfs_initialized: true,
              }),
            );
          }

          // Edge case: no files at all (repo exists but empty)
          if (total === 0) {
            socket.send(
              JSON.stringify({
                type: "list_memory_response",
                request_id: parsed.request_id,
                entries: [],
                done: true,
                total: 0,
                success: true,
                memfs_initialized: true,
              }),
            );
          }
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "list_memory_response",
              request_id: parsed.request_id,
              entries: [],
              done: true,
              total: 0,
              success: false,
              error:
                err instanceof Error ? err.message : "Failed to list memory",
            }),
          );
        }
      })();
      return;
    }

    // ── Enable memfs command ────────────────────────────────────────────
    if (isEnableMemfsCommand(parsed)) {
      void (async () => {
        try {
          const { applyMemfsFlags } = await import(
            "../../agent/memoryFilesystem"
          );
          const result = await applyMemfsFlags(parsed.agent_id, true, false);
          socket.send(
            JSON.stringify({
              type: "enable_memfs_response",
              request_id: parsed.request_id,
              success: true,
              memory_directory: result.memoryDir,
            }),
          );
          // Push memory_updated so the UI auto-refreshes its file list
          socket.send(
            JSON.stringify({
              type: "memory_updated",
              affected_paths: ["*"],
              timestamp: Date.now(),
            }),
          );
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "enable_memfs_response",
              request_id: parsed.request_id,
              success: false,
              error:
                err instanceof Error ? err.message : "Failed to enable memfs",
            }),
          );
        }
      })();
      return;
    }

    // ── Terminal commands (no runtime scope required) ──────────────────
    if (parsed.type === "terminal_spawn") {
      handleTerminalSpawn(
        parsed,
        socket,
        parsed.cwd ?? runtime.bootWorkingDirectory,
      );
      return;
    }

    if (parsed.type === "terminal_input") {
      handleTerminalInput(parsed);
      return;
    }

    if (parsed.type === "terminal_resize") {
      handleTerminalResize(parsed);
      return;
    }

    if (parsed.type === "terminal_kill") {
      handleTerminalKill(parsed);
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
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      conversationRuntime.queuedMessagesByItemId.clear();
      if (conversationRuntime.queueRuntime) {
        conversationRuntime.queueRuntime.clear("shutdown");
      }
    }

    if (isDebugEnabled()) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    clearRuntimeTimers(runtime);
    killAllTerminals();
    runtime.socket = null;
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      rejectPendingApprovalResolvers(
        conversationRuntime,
        "WebSocket disconnected",
      );
      clearConversationRuntimeState(conversationRuntime);
      evictConversationRuntimeIfIdle(conversationRuntime);
    }

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

function asListenerRuntimeForTests(
  runtime: ListenerRuntime | ConversationRuntime,
): ListenerRuntime {
  return "listener" in runtime ? runtime.listener : runtime;
}

function createLegacyTestRuntime(): ConversationRuntime & {
  activeAgentId: string | null;
  activeConversationId: string;
  socket: WebSocket | null;
  workingDirectoryByConversation: Map<string, string>;
  permissionModeByConversation: ListenerRuntime["permissionModeByConversation"];
  bootWorkingDirectory: string;
  connectionId: string | null;
  connectionName: string | null;
  sessionId: string;
  eventSeqCounter: number;
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  onWsEvent?: StartListenerOptions["onWsEvent"];
  reminderState: ListenerRuntime["reminderState"];
  reconnectTimeout: NodeJS.Timeout | null;
  heartbeatInterval: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  conversationRuntimes: ListenerRuntime["conversationRuntimes"];
  approvalRuntimeKeyByRequestId: ListenerRuntime["approvalRuntimeKeyByRequestId"];
  lastEmittedStatus: ListenerRuntime["lastEmittedStatus"];
} {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, null, "default");
  const bridge = runtime as ConversationRuntime & {
    activeAgentId: string | null;
    activeConversationId: string;
    socket: WebSocket | null;
    workingDirectoryByConversation: Map<string, string>;
    permissionModeByConversation: ListenerRuntime["permissionModeByConversation"];
    bootWorkingDirectory: string;
    connectionId: string | null;
    connectionName: string | null;
    sessionId: string;
    eventSeqCounter: number;
    queueEmitScheduled: boolean;
    pendingQueueEmitScope?: {
      agent_id?: string | null;
      conversation_id?: string | null;
    };
    onWsEvent?: StartListenerOptions["onWsEvent"];
    reminderState: ListenerRuntime["reminderState"];
    reconnectTimeout: NodeJS.Timeout | null;
    heartbeatInterval: NodeJS.Timeout | null;
    intentionallyClosed: boolean;
    hasSuccessfulConnection: boolean;
    conversationRuntimes: ListenerRuntime["conversationRuntimes"];
    approvalRuntimeKeyByRequestId: ListenerRuntime["approvalRuntimeKeyByRequestId"];
    lastEmittedStatus: ListenerRuntime["lastEmittedStatus"];
  };
  for (const [prop, getSet] of Object.entries({
    socket: {
      get: () => listener.socket,
      set: (value: WebSocket | null) => {
        listener.socket = value;
      },
    },
    workingDirectoryByConversation: {
      get: () => listener.workingDirectoryByConversation,
      set: (value: Map<string, string>) => {
        listener.workingDirectoryByConversation = value;
      },
    },
    permissionModeByConversation: {
      get: () => listener.permissionModeByConversation,
      set: (value: ListenerRuntime["permissionModeByConversation"]) => {
        listener.permissionModeByConversation = value;
      },
    },
    bootWorkingDirectory: {
      get: () => listener.bootWorkingDirectory,
      set: (value: string) => {
        listener.bootWorkingDirectory = value;
      },
    },
    connectionId: {
      get: () => listener.connectionId,
      set: (value: string | null) => {
        listener.connectionId = value;
      },
    },
    connectionName: {
      get: () => listener.connectionName,
      set: (value: string | null) => {
        listener.connectionName = value;
      },
    },
    sessionId: {
      get: () => listener.sessionId,
      set: (value: string) => {
        listener.sessionId = value;
      },
    },
    eventSeqCounter: {
      get: () => listener.eventSeqCounter,
      set: (value: number) => {
        listener.eventSeqCounter = value;
      },
    },
    queueEmitScheduled: {
      get: () => listener.queueEmitScheduled,
      set: (value: boolean) => {
        listener.queueEmitScheduled = value;
      },
    },
    pendingQueueEmitScope: {
      get: () => listener.pendingQueueEmitScope,
      set: (
        value:
          | {
              agent_id?: string | null;
              conversation_id?: string | null;
            }
          | undefined,
      ) => {
        listener.pendingQueueEmitScope = value;
      },
    },
    onWsEvent: {
      get: () => listener.onWsEvent,
      set: (value: StartListenerOptions["onWsEvent"] | undefined) => {
        listener.onWsEvent = value;
      },
    },
    reminderState: {
      get: () => listener.reminderState,
      set: (value: ListenerRuntime["reminderState"]) => {
        listener.reminderState = value;
      },
    },
    reconnectTimeout: {
      get: () => listener.reconnectTimeout,
      set: (value: NodeJS.Timeout | null) => {
        listener.reconnectTimeout = value;
      },
    },
    heartbeatInterval: {
      get: () => listener.heartbeatInterval,
      set: (value: NodeJS.Timeout | null) => {
        listener.heartbeatInterval = value;
      },
    },
    intentionallyClosed: {
      get: () => listener.intentionallyClosed,
      set: (value: boolean) => {
        listener.intentionallyClosed = value;
      },
    },
    hasSuccessfulConnection: {
      get: () => listener.hasSuccessfulConnection,
      set: (value: boolean) => {
        listener.hasSuccessfulConnection = value;
      },
    },
    conversationRuntimes: {
      get: () => listener.conversationRuntimes,
      set: (value: ListenerRuntime["conversationRuntimes"]) => {
        listener.conversationRuntimes = value;
      },
    },
    approvalRuntimeKeyByRequestId: {
      get: () => listener.approvalRuntimeKeyByRequestId,
      set: (value: ListenerRuntime["approvalRuntimeKeyByRequestId"]) => {
        listener.approvalRuntimeKeyByRequestId = value;
      },
    },
    lastEmittedStatus: {
      get: () => listener.lastEmittedStatus,
      set: (value: ListenerRuntime["lastEmittedStatus"]) => {
        listener.lastEmittedStatus = value;
      },
    },
    activeAgentId: {
      get: () => runtime.agentId,
      set: (value: string | null) => {
        runtime.agentId = value;
      },
    },
    activeConversationId: {
      get: () => runtime.conversationId,
      set: (value: string) => {
        runtime.conversationId = value;
      },
    },
  })) {
    Object.defineProperty(bridge, prop, {
      configurable: true,
      enumerable: false,
      get: getSet.get,
      set: getSet.set,
    });
  }
  return bridge;
}

export {
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "./approval";
export { parseServerMessage } from "./protocol-inbound";
export { emitInterruptedStatusDelta } from "./protocol-outbound";

export const __listenClientTestUtils = {
  createRuntime: createLegacyTestRuntime,
  createListenerRuntime: createRuntime,
  getOrCreateScopedRuntime,
  stopRuntime: (
    runtime: ListenerRuntime | ConversationRuntime,
    suppressCallbacks: boolean,
  ) => stopRuntime(asListenerRuntimeForTests(runtime), suppressCallbacks),
  setActiveRuntime,
  getListenerStatus,
  getOrCreateConversationRuntime,
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
  resolveStaleApprovals,
  normalizeMessageContentImages,
  normalizeInboundMessages,
  consumeQueuedTurn,
  handleIncomingMessage,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
  scheduleQueuePump,
  recoverApprovalStateForSync,
  clearRecoveredApprovalStateForScope: (
    runtime: ListenerRuntime | ConversationRuntime,
    scope?: {
      agent_id?: string | null;
      conversation_id?: string | null;
    },
  ) =>
    clearRecoveredApprovalStateForScope(
      asListenerRuntimeForTests(runtime),
      scope,
    ),
  emitStateSync,
};
