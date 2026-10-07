import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";

export const RECOVERED_APPROVAL_OUTCOME_UNKNOWN =
  "Tool execution may have completed, but the listener stopped before recording its result";

export function createRecoveredApprovalEffectBoundary(params: {
  ownsClaim: () => boolean;
  checkpointUnknown: () => void;
  onCrossed: () => void;
}) {
  let crossed = false;
  let claimLost = false;
  return {
    beforeToolExecution: () => {
      if (!params.ownsClaim()) {
        claimLost = true;
        throw new Error("Recovery claim lost before tool execution");
      }
      if (crossed) return;
      params.checkpointUnknown();
      if (!params.ownsClaim()) {
        claimLost = true;
        throw new Error("Recovery claim lost before tool execution");
      }
      crossed = true;
      params.onCrossed();
    },
    get crossed() {
      return crossed;
    },
    get claimLost() {
      return claimLost;
    },
  };
}

/** Evidence written before execution so a hard death never masquerades as denial. */
export function recoveredApprovalInFlightResults(
  decisions: ApprovalDecision[],
): ApprovalResult[] {
  return decisions.map((decision) => {
    const id = decision.approval.toolCallId;
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
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    };
  });
}

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
