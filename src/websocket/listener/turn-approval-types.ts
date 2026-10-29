import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";
import type { ApprovalContinuationSendResult } from "./send";
import type { TurnInputState } from "./turn-input-state";
import type { PendingTeleport } from "./types";

export type Decision =
  | {
      type: "approve";
      approval: {
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      };
      reason?: string;
    }
  | {
      type: "deny";
      approval: {
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      };
      reason: string;
    };
export type ApprovalBranchProgress = {
  turnInput: TurnInputState;
  dequeuedBatchId: string;
  pendingNormalizationInterruptedToolCallIds: string[];
  turnToolContextId: string | null;
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  lastApprovalContinuationAccepted: boolean;
};
export type ApprovalBranchResult =
  | ({
      kind: "continue";
      stream: Stream<LettaStreamingResponse>;
    } & ApprovalBranchProgress)
  | ({ kind: "interrupted" } & ApprovalBranchProgress)
  | ({
      kind: "teleport";
      pendingTeleport: PendingTeleport;
    } & ApprovalBranchProgress)
  | ({
      kind: "terminal";
      drainResult: Extract<
        ApprovalContinuationSendResult,
        { kind: "terminal" }
      >["drainResult"];
    } & ApprovalBranchProgress)
  | { kind: "error"; message: string };
