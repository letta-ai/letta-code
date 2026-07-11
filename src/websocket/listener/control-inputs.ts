import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type WebSocket from "ws";
import { getBackend } from "@/backend";
import { INTERRUPTED_BY_USER } from "@/constants";
import { migratePermissionMode } from "@/permissions/mode";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
} from "@/types/protocol_v2";
import { isDebugEnabled } from "@/utils/debug";
import {
  rejectPendingApprovalResolvers,
  resolvePendingApprovalResolver,
} from "./approval";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  getConversationWorkingDirectory,
  setConversationWorkingDirectory,
} from "./cwd";
import { stashRecoveredApprovalInterrupts } from "./interrupts";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "./permission-mode";
import {
  emitDeviceStatusUpdate,
  emitInterruptedStatusDelta,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import { scheduleQueuePump } from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { resolveRecoveredApprovalResponse } from "./recovery";
import {
  getActiveRuntime,
  getPendingControlRequestCount,
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
} from "./runtime";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import { setCommandLoopStatus } from "./turn-status";
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

    // Migrate legacy mode values from older clients
    const incomingMode = migratePermissionMode(msg.mode);
    if (!incomingMode) {
      emitLoopErrorNotice(socket, runtime, {
        message: `Unsupported permission mode: ${msg.mode}`,
        stopReason: "error",
        isTerminal: false,
        agentId: scope?.agent_id,
        conversationId: scope?.conversation_id,
      });
      return;
    }

    current.mode = incomingMode;

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
  if (targetRuntime.cancelRequested) {
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
    setCommandLoopStatus: typeof setCommandLoopStatus;
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
    setCommandLoopStatus,
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
    scopedRuntime.turnLifecycle.kind === "idle" &&
    resolvedDeps.getPendingControlRequestCount(listener, scope) === 0;

  if (shouldTrackCommand) {
    resolvedDeps.setCommandLoopStatus(
      scopedRuntime,
      "EXECUTING_COMMAND",
      scope,
    );
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
      resolvedDeps.setCommandLoopStatus(
        scopedRuntime,
        "WAITING_ON_INPUT",
        scope,
      );
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
    socket: ListenerTransport;
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
  const hasActiveTurn = scopedRuntime.turnLifecycle.kind === "active";

  if (!hasActiveTurn && !hasPendingApprovals) {
    return false;
  }

  const cancellation = scopedRuntime.turnLifecycle.requestCancellation();
  const interruptedRunId = cancellation.runId;
  const pendingRequestsSnapshot = hasPendingApprovals
    ? resolvedDeps.getPendingControlRequests(listener, scope)
    : [];

  if (
    cancellation.executingToolCallIds.length > 0 &&
    (!scopedRuntime.pendingInterruptedResults ||
      scopedRuntime.pendingInterruptedResults.length === 0)
  ) {
    scopedRuntime.pendingInterruptedResults =
      cancellation.executingToolCallIds.map((toolCallId) => ({
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
      ...cancellation.executingToolCallIds,
    ];
  }

  // Also set interrupt context for active turns without tracked tool IDs
  // (e.g., background Task tools that spawn subagents)
  if (
    hasActiveTurn &&
    cancellation.executingToolCallIds.length === 0 &&
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
