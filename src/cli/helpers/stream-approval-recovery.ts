import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import type { StreamRequestContext } from "@/agent/message";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import { type createBuffers, onChunk } from "./accumulator";
import type { ApprovalRequest } from "./stream-processor";

export type CurrentPendingApprovalLoader = (
  context: StreamRequestContext | undefined,
  recoveredApprovals: ApprovalRequest[],
) => Promise<ApprovalRequest[]>;

export function retainIncompleteApprovalRequests(
  buffers: ReturnType<typeof createBuffers>,
  approvals: ApprovalRequest[] | undefined,
): ApprovalRequest[] {
  const pending = (approvals ?? []).filter((approval) => {
    const lineId =
      buffers.toolCallIdToLineId.get(approval.toolCallId) ??
      approval.toolCallId;
    const line = buffers.byId.get(lineId);
    return !line || line.kind !== "tool_call" || line.phase !== "finished";
  });
  for (const approval of pending) {
    const lineId =
      buffers.toolCallIdToLineId.get(approval.toolCallId) ??
      approval.toolCallId;
    if (buffers.byId.has(lineId)) continue;
    onChunk(buffers, {
      message_type: "approval_request_message",
      id: approval.messageId,
      tool_call: {
        tool_call_id: approval.toolCallId,
        name: approval.toolName,
        arguments: approval.toolArgs,
      },
    } as unknown as LettaStreamingResponse);
  }
  return pending;
}

async function loadCurrentPendingApprovals(
  context: StreamRequestContext,
): Promise<ApprovalRequest[]> {
  const backend = getBackend();
  let agentId = context.agentId;
  if (!agentId && context.conversationId !== "default") {
    const conversation = await backend.retrieveConversation(
      context.resolvedConversationId,
    );
    agentId = conversation.agent_id;
  }
  if (!agentId) return [];

  const agent = await backend.retrieveAgent(agentId);
  const resumeData = await getResumeDataFromBackend(
    agent,
    context.conversationId,
    { includeMessageHistory: false },
  );
  return resumeData.pendingApprovals;
}

export async function revalidateRecoveredApprovals(params: {
  recoveredApprovals: ApprovalRequest[];
  context: StreamRequestContext | undefined;
  loadCurrentPendingApprovals?: CurrentPendingApprovalLoader;
}): Promise<ApprovalRequest[]> {
  if (params.recoveredApprovals.length === 0) return [];
  if (!params.context && !params.loadCurrentPendingApprovals) {
    debugWarn(
      "stream",
      "Skipping approval recovery without conversation context",
    );
    return [];
  }

  try {
    const currentApprovals = await (
      params.loadCurrentPendingApprovals ?? loadCurrentPendingApprovals
    )(params.context as StreamRequestContext, params.recoveredApprovals);
    const currentByToolCallId = new Map(
      currentApprovals.map((approval) => [approval.toolCallId, approval]),
    );
    const recoveredToolCallIds = new Set(
      params.recoveredApprovals.map((approval) => approval.toolCallId),
    );
    if (
      currentByToolCallId.size !== recoveredToolCallIds.size ||
      !currentApprovals.every((approval) =>
        recoveredToolCallIds.has(approval.toolCallId),
      )
    ) {
      debugWarn(
        "stream",
        "Recovered approval batch does not match current pending tool-call IDs",
      );
      return [];
    }
    return params.recoveredApprovals.flatMap((approval) => {
      const current = currentByToolCallId.get(approval.toolCallId);
      return current ? [current] : [];
    });
  } catch (error) {
    debugWarn(
      "stream",
      "Failed to revalidate recovered approvals against current conversation state: %s",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

export async function revalidateRecoveredApprovalBoundary(
  result: {
    approvals?: ApprovalRequest[];
    approval?: ApprovalRequest | null;
  },
  authoritativeApprovalBoundary: boolean,
  context: StreamRequestContext | undefined,
  loadCurrentPendingApprovals?: CurrentPendingApprovalLoader,
): Promise<boolean> {
  if (!authoritativeApprovalBoundary) return false;
  if ((result.approvals?.length ?? 0) === 0) return false;
  result.approvals = await revalidateRecoveredApprovals({
    recoveredApprovals: result.approvals ?? [],
    context,
    loadCurrentPendingApprovals,
  });
  result.approval = result.approvals[0] ?? null;
  return result.approvals.length > 0;
}
