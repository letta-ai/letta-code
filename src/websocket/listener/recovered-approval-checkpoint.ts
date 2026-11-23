import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";

export const RECOVERED_APPROVAL_OUTCOME_UNKNOWN =
  "Tool execution may have completed, but the listener stopped before recording its result";

function denialResult(
  decision: Extract<ApprovalDecision, { type: "deny" }>,
): ApprovalResult {
  return {
    type: "approval",
    tool_call_id: decision.approval.toolCallId,
    approve: false,
    reason: decision.reason,
  };
}

function unknownResult(toolCallId: string): ApprovalResult {
  return {
    type: "tool",
    tool_call_id: toolCallId,
    status: "error",
    tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
  };
}

function savedResult(
  decision: Extract<ApprovalDecision, { type: "approve" }>,
): ApprovalResult | undefined {
  if (!decision.precomputedResult) return undefined;
  return {
    type: "tool",
    tool_call_id: decision.approval.toolCallId,
    tool_return: decision.precomputedResult.toolReturn,
    status: decision.precomputedResult.status,
    stdout: decision.precomputedResult.stdout,
    stderr: decision.precomputedResult.stderr,
    reason: decision.reason,
  };
}

export function createRecoveredApprovalEffectBoundary(params: {
  decisions: ApprovalDecision[];
  ownsClaim: () => boolean;
  checkpoint: (
    results: ApprovalResult[],
    unstartedToolCallIds: string[],
    phase: "before" | "after" | "rollback",
  ) => void | Promise<void>;
  checkpointExactResult?: (
    result: ApprovalResult,
  ) => boolean | Promise<boolean>;
  onCrossed: () => void;
}) {
  const results = new Map<string, ApprovalResult>();
  const unstarted = new Set(
    params.decisions.flatMap((decision) =>
      decision.type === "approve" && !decision.precomputedResult
        ? [decision.approval.toolCallId]
        : [],
    ),
  );
  for (const decision of params.decisions) {
    if (decision.type === "deny") {
      results.set(decision.approval.toolCallId, denialResult(decision));
    } else {
      const saved = savedResult(decision);
      if (saved) results.set(decision.approval.toolCallId, saved);
    }
  }
  let crossed = false;
  let claimLost = false;
  let transitionChain = Promise.resolve();
  const snapshot = () =>
    params.decisions.flatMap((decision) => {
      const result = results.get(decision.approval.toolCallId);
      return result ? [result] : [];
    });
  return {
    initialResults: snapshot(),
    initialUnstartedToolCallIds: [...unstarted],
    beforeToolExecution: (toolCallId: string) => {
      const operation = transitionChain.then(async () => {
        if (!params.ownsClaim()) {
          claimLost = true;
          throw new Error("Recovery claim lost before tool execution");
        }
        const wasUnstarted = unstarted.has(toolCallId);
        const previousResult = results.get(toolCallId);
        const restoreUnstarted = () => {
          if (wasUnstarted) unstarted.add(toolCallId);
          if (previousResult) results.set(toolCallId, previousResult);
          else results.delete(toolCallId);
        };
        unstarted.delete(toolCallId);
        results.set(toolCallId, unknownResult(toolCallId));
        try {
          await params.checkpoint(snapshot(), [...unstarted], "before");
        } catch (error) {
          restoreUnstarted();
          if (!params.ownsClaim()) claimLost = true;
          throw error;
        }
        if (!params.ownsClaim()) {
          claimLost = true;
          restoreUnstarted();
          await params.checkpoint(snapshot(), [...unstarted], "rollback");
          throw new Error("Recovery claim lost before tool execution");
        }
        if (!crossed) {
          crossed = true;
          params.onCrossed();
        }
      });
      transitionChain = operation.catch(() => {});
      return operation;
    },
    afterToolExecution: (toolCallId: string, result: ApprovalResult) => {
      const operation = transitionChain.then(async () => {
        results.set(toolCallId, result);
        let independentSuccessor = false;
        if (params.checkpointExactResult) {
          independentSuccessor = await params.checkpointExactResult(result);
        } else {
          await params.checkpoint(snapshot(), [...unstarted], "after");
        }
        if (independentSuccessor || !params.ownsClaim()) {
          claimLost = true;
          throw new Error("Recovery claim lost after tool execution");
        }
      });
      transitionChain = operation.catch(() => {});
      return operation;
    },
    get results() {
      return snapshot();
    },
    get unstartedToolCallIds() {
      return [...unstarted];
    },
    get crossed() {
      return crossed;
    },
    get claimLost() {
      return claimLost;
    },
  };
}

export function recoveredApprovalInFlightResults(
  decisions: ApprovalDecision[],
): ApprovalResult[] {
  return decisions.flatMap((decision) =>
    decision.type === "deny" ? [denialResult(decision)] : [],
  );
}

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
  return decisions.flatMap((decision) => {
    const completed = partialById.get(decision.approval.toolCallId);
    if (completed) return [completed];
    return decision.type === "deny" ? [denialResult(decision)] : [];
  });
}
