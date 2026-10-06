import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";

/** Preserve reported partial effects and conservatively close unknown ones. */
export function recoveredApprovalFailureResults(
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
  return decisions.map((decision) => {
    const id = decision.approval.toolCallId;
    const completed = partialById.get(id);
    if (completed) return completed;
    if (decision.type === "deny") {
      return {
        type: "approval",
        tool_call_id: id,
        approve: false,
        reason: decision.reason,
      };
    }
    return {
      type: "tool",
      tool_call_id: id,
      status: "error",
      tool_return: `Approval batch failed: ${String(error)}`,
    };
  });
}
