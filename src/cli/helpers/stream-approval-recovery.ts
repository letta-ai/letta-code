import { getResumeDataFromBackend } from "@/agent/check-approval";
import type { StreamRequestContext } from "@/agent/message";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { ApprovalRequest } from "./stream-processor";

export type CurrentPendingApprovalLoader = (
  context: StreamRequestContext | undefined,
  recoveredApprovals: ApprovalRequest[],
) => Promise<ApprovalRequest[]>;

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
  if (!authoritativeApprovalBoundary || (result.approvals?.length ?? 0) === 0) {
    return authoritativeApprovalBoundary;
  }
  result.approvals = await revalidateRecoveredApprovals({
    recoveredApprovals: result.approvals ?? [],
    context,
    loadCurrentPendingApprovals,
  });
  result.approval = result.approvals[0] ?? null;
  return result.approvals.length > 0;
}
