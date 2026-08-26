import type { ApprovalResult } from "@/agent/approval-execution";
import type { ApprovalResponseBody, ControlRequest } from "@/types/protocol_v2";
import {
  createConnectionRequestKey,
  findListenerConnectionByTransport,
  getSubscribedListenerConnections,
  TO_SUBSCRIBERS,
  toListenerConnection,
} from "./connection";
import {
  emitDeviceStatusIfOpen,
  emitLoopStatusIfOpen,
  emitProtocolV2Message,
} from "./protocol-outbound";
import { evictConversationRuntimeIfIdle } from "./runtime";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import type { TurnLease } from "./turn-lifecycle";
import { setCommandLoopStatus, setTurnLoopStatus } from "./turn-status";
import type { ConversationRuntime, ListenerConnectionId } from "./types";

const UNOWNED_APPROVAL_CONNECTION_ID = "__unowned_approval__";

function pendingApprovalEntries(
  runtime: ConversationRuntime,
): import("./types").PendingApprovalResolver[] {
  return [...new Set(runtime.pendingApprovalResolvers.values())];
}

function removePendingApproval(
  runtime: ConversationRuntime,
  pending: import("./types").PendingApprovalResolver,
): void {
  for (const [requestKey, candidate] of runtime.pendingApprovalResolvers) {
    if (candidate !== pending) continue;
    runtime.pendingApprovalResolvers.delete(requestKey);
  }
  pending.connectionIds.clear();
}

function addPendingApprovalConnection(
  runtime: ConversationRuntime,
  pending: import("./types").PendingApprovalResolver,
  connectionId: ListenerConnectionId,
): void {
  const unownedKey = createConnectionRequestKey(
    UNOWNED_APPROVAL_CONNECTION_ID,
    pending.requestId,
  );
  runtime.pendingApprovalResolvers.delete(unownedKey);
  const requestKey = createConnectionRequestKey(
    connectionId,
    pending.requestId,
  );
  pending.connectionIds.add(connectionId);
  runtime.pendingApprovalResolvers.set(requestKey, pending);
}

function keepPendingApprovalUnowned(
  runtime: ConversationRuntime,
  pending: import("./types").PendingApprovalResolver,
): void {
  const requestKey = createConnectionRequestKey(
    UNOWNED_APPROVAL_CONNECTION_ID,
    pending.requestId,
  );
  runtime.pendingApprovalResolvers.set(requestKey, pending);
}

export function hasPendingApprovalRequestId(
  runtime: ConversationRuntime,
  requestId: string,
): boolean {
  return pendingApprovalEntries(runtime).some(
    (pending) => pending.requestId === requestId,
  );
}

export function getPendingApprovalRequestIds(
  runtime: ConversationRuntime,
): Set<string> {
  return new Set(
    pendingApprovalEntries(runtime).map((pending) => pending.requestId),
  );
}

export function rememberPendingApprovalBatchIds(
  runtime: ConversationRuntime,
  pendingApprovals: Array<{ toolCallId: string; messageId?: string }>,
  batchId: string,
): void {
  for (const approval of pendingApprovals) {
    if (approval.toolCallId) {
      runtime.pendingApprovalBatchByToolCallId.set(
        approval.toolCallId,
        batchId,
      );
      if (approval.messageId) {
        runtime.approvalMessageIdByToolCallId.set(
          approval.toolCallId,
          approval.messageId,
        );
      }
    }
  }
}

export function resolvePendingApprovalBatchId(
  runtime: ConversationRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
): string | null {
  const batchIds = new Set<string>();
  for (const approval of pendingApprovals) {
    const batchId = runtime.pendingApprovalBatchByToolCallId.get(
      approval.toolCallId,
    );
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

export function resolveRecoveryBatchId(
  runtime: ConversationRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
): string | null {
  if (runtime.pendingApprovalBatchByToolCallId.size === 0) {
    return `recovery-${crypto.randomUUID()}`;
  }
  return resolvePendingApprovalBatchId(runtime, pendingApprovals);
}

export function clearPendingApprovalBatchIds(
  runtime: ConversationRuntime,
  approvals: Array<{ toolCallId: string }>,
): void {
  for (const approval of approvals) {
    runtime.pendingApprovalBatchByToolCallId.delete(approval.toolCallId);
    runtime.approvalMessageIdByToolCallId.delete(approval.toolCallId);
  }
}

export function isValidApprovalResponseBody(
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
    selected_permission_suggestion_ids?: unknown;
  };
  if (decision.behavior === "allow") {
    const hasMessage =
      decision.message === undefined || typeof decision.message === "string";
    const hasUpdatedInput =
      decision.updated_input === undefined ||
      decision.updated_input === null ||
      typeof decision.updated_input === "object";
    const hasSelectedPermissionSuggestionIds =
      decision.selected_permission_suggestion_ids === undefined ||
      (Array.isArray(decision.selected_permission_suggestion_ids) &&
        decision.selected_permission_suggestion_ids.every(
          (entry) => typeof entry === "string",
        ));
    return hasMessage && hasUpdatedInput && hasSelectedPermissionSuggestionIds;
  }
  if (decision.behavior === "deny") {
    return typeof decision.message === "string";
  }
  return false;
}

export function collectApprovalResultToolCallIds(
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

export function collectDecisionToolCallIds(
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

export function validateApprovalResultIds(
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

export function resolvePendingApprovalResolver(
  runtime: ConversationRuntime,
  response: ApprovalResponseBody,
  connectionId?: ListenerConnectionId,
): boolean {
  const requestId = response.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return false;
  }

  const requestKey = connectionId
    ? createConnectionRequestKey(connectionId, requestId)
    : [...runtime.pendingApprovalResolvers.entries()].find(
        ([, candidate]) => candidate.requestId === requestId,
      )?.[0];
  if (!requestKey) {
    return false;
  }
  const pending = runtime.pendingApprovalResolvers.get(requestKey);
  if (!pending) {
    return false;
  }

  removePendingApproval(runtime, pending);
  if (runtime.pendingApprovalResolvers.size === 0 && !runtime.isProcessing) {
    setCommandLoopStatus(runtime, "WAITING_ON_INPUT");
  }
  pending.resolve(response);
  emitLoopStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  emitDeviceStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  evictConversationRuntimeIfIdle(runtime);
  return true;
}

export function rejectPendingApprovalResolvers(
  runtime: ConversationRuntime,
  reason: string,
): void {
  for (const pending of pendingApprovalEntries(runtime)) {
    pending.reject(new Error(reason));
  }
  runtime.pendingApprovalResolvers.clear();
  if (!runtime.isProcessing && !runtime.cancelRequested) {
    setCommandLoopStatus(runtime, "WAITING_ON_INPUT");
  }
  emitLoopStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  emitDeviceStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  evictConversationRuntimeIfIdle(runtime);
}

export function rejectPendingApprovalResolversForConnection(
  runtime: ConversationRuntime,
  connectionId: ListenerConnectionId,
  _reason: string,
): void {
  for (const pending of pendingApprovalEntries(runtime)) {
    if (!pending.connectionIds.delete(connectionId)) {
      continue;
    }
    const requestKey = createConnectionRequestKey(
      connectionId,
      pending.requestId,
    );
    runtime.pendingApprovalResolvers.delete(requestKey);
    if (pending.connectionIds.size === 0) {
      // Codex keeps a thread-scoped server request alive when its last
      // subscriber disconnects and replays it to a later subscriber. The
      // listener turn's abort signal remains the authority for cancellation.
      keepPendingApprovalUnowned(runtime, pending);
    }
  }
  evictConversationRuntimeIfIdle(runtime);
}

export function replayPendingApprovalRequestsToConnection(
  runtime: ConversationRuntime,
  connectionId: ListenerConnectionId,
): void {
  const connection = runtime.listener.connections.get(connectionId);
  if (!connection?.initialized || !isListenerTransportOpen(connection.writer)) {
    return;
  }
  for (const pending of pendingApprovalEntries(runtime)) {
    addPendingApprovalConnection(runtime, pending, connectionId);
    if (!pending.controlRequest) continue;
    emitProtocolV2Message(
      connection.writer,
      runtime,
      pending.controlRequest,
      {
        agent_id: runtime.agentId,
        conversation_id: runtime.conversationId,
      },
      toListenerConnection(connectionId),
    );
  }
  const recovered = runtime.recoveredApprovalState;
  if (
    recovered?.agentId !== runtime.agentId ||
    recovered.conversationId !== runtime.conversationId
  ) {
    return;
  }
  for (const requestId of recovered.pendingRequestIds) {
    const pending = recovered.approvalsByRequestId.get(requestId);
    if (!pending) continue;
    emitProtocolV2Message(
      connection.writer,
      runtime,
      pending.controlRequest,
      {
        agent_id: runtime.agentId,
        conversation_id: runtime.conversationId,
      },
      toListenerConnection(connectionId),
    );
  }
}

export function requestApprovalOverWS(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  turnLease: TurnLease,
  requestId: string,
  controlRequest: ControlRequest,
): Promise<ApprovalResponseBody> {
  if (runtime.listener.intentionallyClosed) {
    return Promise.reject(new Error("Listener runtime stopped"));
  }

  const scope = {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  };
  const subscribers = getSubscribedListenerConnections(runtime.listener, scope);
  const originConnection = findListenerConnectionByTransport(
    runtime.listener,
    socket,
  );
  const connectionIds = new Set(subscribers.map((subscriber) => subscriber.id));
  if (
    connectionIds.size === 0 &&
    originConnection?.initialized &&
    isListenerTransportOpen(originConnection.writer)
  ) {
    connectionIds.add(originConnection.id);
  }
  if (
    connectionIds.size === 0 &&
    runtime.listener.connections.size === 0 &&
    isListenerTransportOpen(socket)
  ) {
    connectionIds.add(runtime.listener.connectionId ?? "legacy");
  }
  const abortSignal = turnLease.signal;
  const isInterrupted = () =>
    !runtime.turnLifecycle.isCurrent(turnLease) || abortSignal.aborted;

  if (isInterrupted()) {
    return Promise.reject(new Error("Cancelled by user"));
  }

  return new Promise<ApprovalResponseBody>((resolve, reject) => {
    let settled = false;
    const pending: import("./types").PendingApprovalResolver = {
      requestId,
      connectionIds,
      resolve: (response) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbortListener();
        resolve(response);
      },
      reject: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbortListener();
        reject(error);
      },
      controlRequest,
    };
    const cleanupAbortListener = () => {
      abortSignal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      removePendingApproval(runtime, pending);
      pending.reject(new Error("Cancelled by user"));
    };

    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (isInterrupted()) {
      handleAbort();
      return;
    }

    if (connectionIds.size === 0) {
      keepPendingApprovalUnowned(runtime, pending);
    } else {
      for (const connectionId of connectionIds) {
        addPendingApprovalConnection(runtime, pending, connectionId);
      }
    }
    if (isInterrupted()) {
      handleAbort();
      return;
    }
    runtime.turnLifecycle.recordStopReason(turnLease, "requires_approval");
    setTurnLoopStatus(runtime, turnLease, "WAITING_ON_APPROVAL");
    emitProtocolV2Message(
      socket,
      runtime,
      controlRequest,
      scope,
      TO_SUBSCRIBERS,
    );
    emitLoopStatusIfOpen(runtime.listener, {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    });
    emitDeviceStatusIfOpen(runtime.listener, {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    });
  });
}

export function parseApprovalInput(toolArgs: string): Record<string, unknown> {
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
