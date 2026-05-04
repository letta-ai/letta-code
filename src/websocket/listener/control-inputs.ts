import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type WebSocket from "ws";
import { getBackend } from "../../backend";
import {
  ensureFileIndex,
  getIndexRoot,
  setIndexRoot,
} from "../../cli/helpers/fileIndex";
import { generatePlanFilePath } from "../../cli/helpers/planName";
import { INTERRUPTED_BY_USER } from "../../constants";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
} from "../../types/protocol_v2";
import { isDebugEnabled } from "../../utils/debug";
import {
  rejectPendingApprovalResolvers,
  resolvePendingApprovalResolver,
} from "./approval";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  getConversationWorkingDirectory,
  setConversationWorkingDirectory,
} from "./cwd";
import { isGitWorktreeRoot } from "./file-commands";
import { stashRecoveredApprovalInterrupts } from "./interrupts";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "./permissionMode";
import {
  emitDeviceStatusUpdate,
  emitInterruptedStatusDelta,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import { scheduleQueuePump } from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { resolveRecoveredApprovalResponse } from "./recovery";
import {
  clearActiveRunState,
  getActiveRuntime,
  getPendingControlRequestCount,
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
} from "./runtime";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import type {
  ChangeCwdMessage,
  ConversationRuntime,
  ListenerRuntime,
  ModeChangePayload,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";
import { restartWorktreeWatcher } from "./worktree-watcher";

function trackListenerError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

/**
 * Handle mode change request from cloud.
 * Stores the new mode in ListenerRuntime.permissionModeByConversation so
 * each agent/conversation is isolated and the state outlives the ephemeral
 * ConversationRuntime (which gets evicted between turns).
 */
export function handleModeChange(
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
    const current = getOrCreateConversationPermissionModeStateRef(
      runtime,
      agentId,
      conversationId,
    );

    // Track previous mode so ExitPlanMode can restore it
    if (msg.mode === "plan" && current.mode !== "plan") {
      current.modeBeforePlan = current.mode;
    }
    current.mode = msg.mode;

    // Generate plan file path when entering plan mode
    if (msg.mode === "plan" && !current.planFilePath) {
      current.planFilePath = generatePlanFilePath();
    }

    // Clear plan-related state when leaving plan mode
    if (msg.mode !== "plan") {
      current.planFilePath = null;
      current.modeBeforePlan = null;
    }

    persistPermissionModeMapForRuntime(runtime);

    emitRuntimeStateUpdates(runtime, scope);

    if (isDebugEnabled()) {
      console.log(`[Listen] Mode changed to: ${msg.mode}`);
    }
  } catch (error) {
    trackListenerError(
      "listener_mode_change_failed",
      error,
      "listener_mode_change",
    );
    emitLoopErrorNotice(socket, runtime, {
      message: error instanceof Error ? error.message : "Mode change failed",
      stopReason: "error",
      isTerminal: false,
      agentId: scope?.agent_id,
      conversationId: scope?.conversation_id,
      error,
    });

    if (isDebugEnabled()) {
      console.error("[Listen] Mode change failed:", error);
    }
  }
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

export async function handleApprovalResponseInput(
  listener: ListenerRuntime,
  params: {
    runtime: {
      agent_id?: string | null;
      conversation_id?: string | null;
    };
    response: ApprovalResponseBody;
    socket: ListenerTransport;
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
      socket: ListenerTransport,
      response: ApprovalResponseBody,
      processTurn: typeof handleIncomingMessage,
      opts?: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      },
    ) => Promise<boolean>;
    scheduleQueuePump: (
      runtime: ConversationRuntime,
      socket: ListenerTransport,
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
  if (targetRuntime.cancelRequested && !targetRuntime.isProcessing) {
    targetRuntime.cancelRequested = false;
    deps.scheduleQueuePump(
      targetRuntime,
      params.socket,
      params.opts as StartListenerOptions,
      params.processQueuedTurn,
    );
    return false;
  }
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

export async function handleChangeDeviceStateInput(
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

export async function handleAbortMessageInput(
  listener: ListenerRuntime,
  params: {
    command: AbortMessageCommand;
    socket: WebSocket;
    opts: {
      onStatusChange?: StartListenerOptions["onStatusChange"];
      connectionId?: string;
    };
    processQueuedTurn: ProcessQueuedTurn;
  },
  deps: Partial<{
    getActiveRuntime: typeof getActiveRuntime;
    getPendingControlRequestCount: typeof getPendingControlRequestCount;
    getPendingControlRequests: typeof getPendingControlRequests;
    getOrCreateScopedRuntime: typeof getOrCreateScopedRuntime;
    getRecoveredApprovalStateForScope: typeof getRecoveredApprovalStateForScope;
    stashRecoveredApprovalInterrupts: typeof stashRecoveredApprovalInterrupts;
    rejectPendingApprovalResolvers: typeof rejectPendingApprovalResolvers;
    setLoopStatus: typeof setLoopStatus;
    clearActiveRunState: typeof clearActiveRunState;
    emitRuntimeStateUpdates: typeof emitRuntimeStateUpdates;
    emitInterruptedStatusDelta: typeof emitInterruptedStatusDelta;
    scheduleQueuePump: typeof scheduleQueuePump;
    cancelConversation: (
      agentId: string,
      conversationId: string,
    ) => Promise<void>;
  }> = {},
): Promise<boolean> {
  const resolvedDeps = {
    getActiveRuntime,
    getPendingControlRequestCount,
    getPendingControlRequests,
    getOrCreateScopedRuntime,
    getRecoveredApprovalStateForScope,
    stashRecoveredApprovalInterrupts,
    rejectPendingApprovalResolvers,
    setLoopStatus,
    clearActiveRunState,
    emitRuntimeStateUpdates,
    emitInterruptedStatusDelta,
    scheduleQueuePump,
    cancelConversation: async (agentId: string, conversationId: string) => {
      const cancelId =
        conversationId === "default" || !conversationId
          ? agentId
          : conversationId;
      await getBackend().cancelConversation(cancelId);
    },
    ...deps,
  };

  if (
    listener !== resolvedDeps.getActiveRuntime() ||
    listener.intentionallyClosed
  ) {
    return false;
  }

  const scope = {
    agent_id: params.command.runtime.agent_id,
    conversation_id: params.command.runtime.conversation_id,
  };
  const hasPendingApprovals =
    resolvedDeps.getPendingControlRequestCount(listener, scope) > 0;
  const scopedRuntime = resolvedDeps.getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const hasActiveTurn = scopedRuntime.isProcessing;

  if (!hasActiveTurn && !hasPendingApprovals) {
    return false;
  }

  const interruptedRunId = scopedRuntime.activeRunId;
  scopedRuntime.cancelRequested = true;
  const pendingRequestsSnapshot = hasPendingApprovals
    ? resolvedDeps.getPendingControlRequests(listener, scope)
    : [];

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

  // Also set interrupt context for active turns without tracked tool IDs
  // (e.g., background Task tools that spawn subagents)
  if (
    hasActiveTurn &&
    scopedRuntime.activeExecutingToolCallIds.length === 0 &&
    !scopedRuntime.pendingInterruptedContext
  ) {
    scopedRuntime.pendingInterruptedContext = {
      agentId: scopedRuntime.agentId || "",
      conversationId: scopedRuntime.conversationId,
      continuationEpoch: scopedRuntime.continuationEpoch,
    };
    // Set empty results array so hasInterruptedCacheForScope can detect the interrupt
    scopedRuntime.pendingInterruptedResults = [];
  }

  if (
    scopedRuntime.activeAbortController &&
    !scopedRuntime.activeAbortController.signal.aborted
  ) {
    scopedRuntime.activeAbortController.abort();
  }

  const recoveredApprovalState = resolvedDeps.getRecoveredApprovalStateForScope(
    listener,
    scope,
  );
  if (recoveredApprovalState && !hasActiveTurn) {
    resolvedDeps.stashRecoveredApprovalInterrupts(
      scopedRuntime,
      recoveredApprovalState,
    );
  }

  if (hasPendingApprovals) {
    resolvedDeps.rejectPendingApprovalResolvers(
      scopedRuntime,
      "Cancelled by user",
    );
  }

  if (hasActiveTurn) {
    scopedRuntime.lastStopReason = "cancelled";
    scopedRuntime.isProcessing = false;
    resolvedDeps.clearActiveRunState(scopedRuntime);
    resolvedDeps.setLoopStatus(scopedRuntime, "WAITING_ON_INPUT", scope);
    resolvedDeps.emitRuntimeStateUpdates(scopedRuntime, scope);
    resolvedDeps.emitInterruptedStatusDelta(params.socket, scopedRuntime, {
      runId: interruptedRunId,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
    });
  } else if (
    hasPendingApprovals &&
    (!scopedRuntime.pendingInterruptedResults ||
      scopedRuntime.pendingInterruptedResults.length === 0) &&
    pendingRequestsSnapshot.length > 0
  ) {
    // Populate interrupted cache to prevent stale approval recovery on sync
    scopedRuntime.pendingInterruptedResults = pendingRequestsSnapshot.map(
      (req) => ({
        type: "approval" as const,
        tool_call_id: req.request.tool_call_id,
        approve: false,
        reason: "User interrupted the stream",
      }),
    );
    scopedRuntime.pendingInterruptedContext = {
      agentId: scope.agent_id || "",
      conversationId: scope.conversation_id,
      continuationEpoch: scopedRuntime.continuationEpoch,
    };
    scopedRuntime.pendingInterruptedToolCallIds = null;
    resolvedDeps.emitInterruptedStatusDelta(params.socket, scopedRuntime, {
      runId: interruptedRunId,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
    });
  }

  if (!hasActiveTurn) {
    scopedRuntime.cancelRequested = false;
  }

  const cancelConversationId = scopedRuntime.conversationId;
  const cancelAgentId = scopedRuntime.agentId;
  if (cancelAgentId) {
    void resolvedDeps
      .cancelConversation(cancelAgentId, cancelConversationId)
      .catch(() => {
        // Fire-and-forget
      });
  }

  resolvedDeps.scheduleQueuePump(
    scopedRuntime,
    params.socket,
    params.opts as StartListenerOptions,
    params.processQueuedTurn,
  );
  return true;
}

export async function handleCwdChange(
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

    // Invalidate session-context only (not agent-info) so the agent gets
    // updated CWD/git info on the next turn.
    runtime.reminderState.hasSentSessionContext = false;
    runtime.reminderState.pendingSessionContextReason = "cwd_changed";

    // If the new cwd is outside the current file-index root, or is a git
    // worktree nested under it, re-root the index so file search covers
    // the new workspace.  setIndexRoot() triggers a non-blocking rebuild
    // and does NOT mutate process.cwd(), keeping concurrent conversations safe.
    const currentRoot = getIndexRoot();
    const needsReroot =
      !normalizedPath.startsWith(currentRoot) ||
      (normalizedPath !== currentRoot &&
        (await isGitWorktreeRoot(normalizedPath)));
    if (needsReroot) {
      setIndexRoot(normalizedPath);
    }

    // Proactively warm the file index so @ file search is instant when
    // the user first types "@".  ensureFileIndex() is idempotent — if the
    // index was already built (or a rebuild is in-flight from setIndexRoot
    // above), this returns immediately / joins the existing promise.
    void ensureFileIndex();

    emitDeviceStatusUpdate(socket, runtime, {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    // Restart the worktree file watcher for the new CWD so we detect
    // any future worktree creation under the updated directory.
    restartWorktreeWatcher({
      runtime: runtime.listener,
      agentId,
      conversationId,
    });
  } catch (error) {
    emitLoopErrorNotice(socket, runtime, {
      message:
        error instanceof Error
          ? error.message
          : "Working directory change failed",
      stopReason: "error",
      isTerminal: false,
      agentId,
      conversationId,
      error,
    });
  }
}
