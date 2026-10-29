import type { ApprovalResult } from "@/agent/approval-execution";

type ApprovalDecision = {
  type: "approve" | "deny";
  approval: { toolCallId: string };
  reason?: string;
};

export function approvalExecutionFailureResults(
  decisions: ApprovalDecision[],
  error: unknown,
): ApprovalResult[] {
  const partial =
    error && typeof error === "object"
      ? (("results" in error && Array.isArray(error.results)
          ? error.results
          : "partialResults" in error && Array.isArray(error.partialResults)
            ? error.partialResults
            : []) as ApprovalResult[])
      : [];
  const partialById = new Map(
    partial
      .filter((result) => result && typeof result.tool_call_id === "string")
      .map((result) => [result.tool_call_id, result]),
  );
  const failure = `Approval batch failed: ${String(error)}`;
  return decisions.map((decision) => {
    const toolCallId = decision.approval.toolCallId;
    const completed = partialById.get(toolCallId);
    if (completed) return completed;
    if (decision.type === "deny") {
      return {
        type: "approval",
        tool_call_id: toolCallId,
        approve: false,
        reason: decision.reason ?? "Denied",
      };
    }
    return {
      type: "tool",
      tool_call_id: toolCallId,
      tool_return: failure,
      status: "error",
      reason: decision.reason,
    };
  });
}
