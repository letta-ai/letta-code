import type WebSocket from "ws";
import type { ApprovalResult } from "../../agent/approval-execution";
import { normalizeApprovalResultsForPersistence } from "../../agent/approval-result-normalization";
import { INTERRUPTED_BY_USER } from "../../constants";
import type {
  ClientToolEndMessage,
  ClientToolStartMessage,
} from "../../types/protocol_v2";
import { isDebugEnabled } from "../../utils/debug";
import { collectApprovalResultToolCallIds } from "./approval";
import {
  createLifecycleMessageBase,
  emitCanonicalMessageDelta,
} from "./protocol-outbound";
import { clearRecoveredApprovalState } from "./runtime";
import type {
  ConversationRuntime,
  InterruptPopulateInput,
  InterruptToolReturn,
  RecoveredApprovalState,
} from "./types";

export function asToolReturnStatus(value: unknown): "success" | "error" | null {
  if (value === "success" || value === "error") {
    return value;
  }
  return null;
}

export function normalizeToolReturnValue(value: unknown): string {
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

export function normalizeInterruptedApprovalsForQueue(
  approvals: ApprovalResult[] | null,
  interruptedToolCallIds: string[],
): ApprovalResult[] | null {
  if (!approvals || approvals.length === 0) {
    return approvals;
  }

  return normalizeApprovalResultsForPersistence(approvals, {
    interruptedToolCallIds,
    allowInterruptTextFallback: true,
  });
}

export function normalizeExecutionResultsForInterruptParity(
  runtime: ConversationRuntime,
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

export function extractCanonicalToolReturnsFromWire(
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

export function normalizeToolReturnWireMessage(
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

export function extractInterruptToolReturns(
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

export function emitInterruptToolReturnMessage(
  socket: WebSocket,
  runtime: ConversationRuntime,
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
        agent_id: runtime.agentId ?? undefined,
        conversation_id: runtime.conversationId,
      },
    );
  }
}

export function emitToolExecutionStartedEvents(
  socket: WebSocket,
  runtime: ConversationRuntime,
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

export function emitToolExecutionFinishedEvents(
  socket: WebSocket,
  runtime: ConversationRuntime,
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

export function getInterruptApprovalsForEmission(
  runtime: ConversationRuntime,
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

export function populateInterruptQueue(
  runtime: ConversationRuntime,
  input: InterruptPopulateInput,
): boolean {
  const shouldPopulate =
    !runtime.pendingInterruptedResults ||
    runtime.pendingInterruptedResults.length === 0 ||
    !runtime.pendingInterruptedContext;

  if (!shouldPopulate) return false;

  if (input.lastExecutionResults && input.lastExecutionResults.length > 0) {
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

export function consumeInterruptQueue(
  runtime: ConversationRuntime,
  agentId: string,
  conversationId: string,
): {
  approvalMessage: {
    type: "approval";
    approvals: ApprovalResult[];
    otid?: string;
  };
  interruptedToolCallIds: string[];
} | null {
  const ctx = runtime.pendingInterruptedContext;
  const matchingContext =
    !!ctx &&
    ctx.agentId === agentId &&
    ctx.conversationId === conversationId &&
    ctx.continuationEpoch === runtime.continuationEpoch;

  if (
    !runtime.pendingInterruptedResults ||
    runtime.pendingInterruptedResults.length === 0
  ) {
    if (matchingContext) {
      runtime.pendingInterruptedResults = null;
      runtime.pendingInterruptedContext = null;
      runtime.pendingInterruptedToolCallIds = null;
    }
    return null;
  }

  let result: {
    approvalMessage: {
      type: "approval";
      approvals: ApprovalResult[];
      otid?: string;
    };
    interruptedToolCallIds: string[];
  } | null = null;

  if (matchingContext) {
    result = {
      approvalMessage: {
        type: "approval",
        approvals: runtime.pendingInterruptedResults,
        otid: crypto.randomUUID(),
      },
      interruptedToolCallIds: runtime.pendingInterruptedToolCallIds
        ? [...runtime.pendingInterruptedToolCallIds]
        : [],
    };
  }

  const queuedToolCallIds = collectApprovalResultToolCallIds(
    runtime.pendingInterruptedResults,
  );

  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  for (const toolCallId of queuedToolCallIds) {
    runtime.pendingApprovalBatchByToolCallId.delete(toolCallId);
  }

  return result;
}

export function stashRecoveredApprovalInterrupts(
  runtime: ConversationRuntime,
  recovered: RecoveredApprovalState,
): boolean {
  const approvals =
    recovered.allApprovals ??
    [...recovered.approvalsByRequestId.values()].map((entry) => entry.approval);
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
