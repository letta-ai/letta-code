// src/cli/app/useInterruptHandler.ts

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import { getSubagents, interruptActiveSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import type { Buffers } from "@/cli/helpers/accumulator";
import { markIncompleteToolsAsCancelled } from "@/cli/helpers/accumulator";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { releaseReflectionLaunch } from "@/cli/helpers/reflection-launcher";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { INTERRUPTED_BY_USER } from "@/constants";
import type { ApprovalContext } from "@/permissions/analyzer";

import { EAGER_CANCEL, INTERRUPT_MESSAGE } from "./constants";
import { extractErrorMeta } from "./errors";
import type {
  AppendError,
  ApprovalDecision,
  AutoAllowedExecution,
  AutoDeniedApproval,
  AutoHandledToolResult,
  QueueApprovalResults,
} from "./types";

type InterruptHandlerContext = {
  abortControllerRef: MutableRefObject<AbortController | null>;
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  appendError: AppendError;
  autoAllowedExecutionRef: MutableRefObject<AutoAllowedExecution | null>;
  autoDeniedApprovals: AutoDeniedApproval[];
  autoHandledResults: AutoHandledToolResult[];
  buffersRef: MutableRefObject<Buffers>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  executingToolCallIdsRef: MutableRefObject<string[]>;
  interruptQueuedRef: MutableRefObject<boolean>;
  interruptRequested: boolean;
  isExecutingTool: boolean;
  pendingApprovals: ApprovalRequest[];
  pendingInterruptRecoveryConversationIdRef: MutableRefObject<string | null>;
  processingConversationRef: MutableRefObject<number>;
  queueApprovalResults: QueueApprovalResults;
  refreshDerived: () => void;
  resetTrajectoryBases: () => void;
  setApprovalContexts: Dispatch<SetStateAction<ApprovalContext[]>>;
  setApprovalResults: Dispatch<SetStateAction<ApprovalDecision[]>>;
  setAutoDeniedApprovals: Dispatch<SetStateAction<AutoDeniedApproval[]>>;
  setAutoHandledResults: Dispatch<SetStateAction<AutoHandledToolResult[]>>;
  setInterruptRequested: Dispatch<SetStateAction<boolean>>;
  setIsExecutingTool: Dispatch<SetStateAction<boolean>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setRestoreQueueOnCancel: Dispatch<SetStateAction<boolean>>;
  setStreaming: (value: boolean) => void;
  streaming: boolean;
  toolAbortControllerRef: MutableRefObject<AbortController | null>;
  toolResultsInFlightRef: MutableRefObject<boolean>;
  userCancelledRef: MutableRefObject<boolean>;
  waitingForQueueCancelRef: MutableRefObject<boolean>;
};

function hasActiveReflectionSubagentForAgent(agentId: string): boolean {
  return getSubagents().some((agent) => {
    if (agent.type.toLowerCase() !== "reflection") return false;
    if (agent.status !== "pending" && agent.status !== "running") return false;
    return agent.parentAgentId === agentId;
  });
}

function interruptSubagentsAndReleaseReflection(agentId: string): void {
  const interruptedReflection = hasActiveReflectionSubagentForAgent(agentId);
  interruptActiveSubagents(INTERRUPTED_BY_USER);
  if (interruptedReflection) {
    releaseReflectionLaunch(agentId);
  }
}

export function useInterruptHandler(ctx: InterruptHandlerContext) {
  const {
    abortControllerRef,
    agentId,
    agentIdRef,
    appendError,
    autoAllowedExecutionRef,
    autoDeniedApprovals,
    autoHandledResults,
    buffersRef,
    conversationGenerationRef,
    conversationIdRef,
    executingToolCallIdsRef,
    interruptQueuedRef,
    interruptRequested,
    isExecutingTool,
    pendingApprovals,
    pendingInterruptRecoveryConversationIdRef,
    processingConversationRef,
    queueApprovalResults,
    refreshDerived,
    resetTrajectoryBases,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setInterruptRequested,
    setIsExecutingTool,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setStreaming,
    streaming,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    userCancelledRef,
    waitingForQueueCancelRef,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects; .current is read dynamically when interrupt fires.
  const handleInterrupt = useCallback(async () => {
    // If we're executing client-side tools, abort them AND the main stream
    const hasTrackedTools =
      executingToolCallIdsRef.current.length > 0 ||
      autoAllowedExecutionRef.current?.results;
    if (
      isExecutingTool &&
      toolAbortControllerRef.current &&
      hasTrackedTools &&
      !toolResultsInFlightRef.current
    ) {
      toolAbortControllerRef.current.abort();

      // Mark any in-flight conversation as stale, consistent with EAGER_CANCEL.
      // Increment before tagging queued results so they are tied to the post-interrupt state.
      conversationGenerationRef.current += 1;
      processingConversationRef.current = 0;

      const autoAllowedResults = autoAllowedExecutionRef.current?.results;
      const autoAllowedMetadata = autoAllowedExecutionRef.current
        ? {
            conversationId: autoAllowedExecutionRef.current.conversationId,
            generation: conversationGenerationRef.current,
          }
        : undefined;
      if (autoAllowedResults && autoAllowedResults.length > 0) {
        queueApprovalResults(autoAllowedResults, autoAllowedMetadata);
        interruptQueuedRef.current = true;
      } else if (executingToolCallIdsRef.current.length > 0) {
        const interruptedResults: ApprovalResult[] =
          executingToolCallIdsRef.current.map((toolCallId) => ({
            type: "tool" as const,
            tool_call_id: toolCallId,
            tool_return: INTERRUPTED_BY_USER,
            status: "error" as const,
          }));
        queueApprovalResults(interruptedResults);
        interruptQueuedRef.current = true;
      }
      executingToolCallIdsRef.current = [];
      autoAllowedExecutionRef.current = null;

      // ALSO abort the main stream - don't leave it running
      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(
        buffersRef.current,
        true,
        "user_interrupt",
      );

      // Mark any running subagents as interrupted. If this interrupted a
      // background reflection, also release its launch reservation so ESC does
      // not leave future reflections blocked waiting for an onComplete callback
      // that may never fire.
      interruptSubagentsAndReleaseReflection(agentId);

      // Show interrupt feedback (yellow message if no tools were cancelled)
      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true; // Prevent dequeue
      setStreaming(false);
      resetTrajectoryBases();
      setIsExecutingTool(false);
      toolResultsInFlightRef.current = false;
      refreshDerived();

      // Send cancel request to backend (fire-and-forget).
      // Without this, the backend stays in requires_approval state after tool interrupt,
      // causing CONFLICT on the next user message.
      Promise.resolve()
        .then(() => {
          const cancelConversationId =
            conversationIdRef.current === "default"
              ? agentIdRef.current
              : conversationIdRef.current;
          if (!cancelConversationId || cancelConversationId === "loading") {
            return;
          }
          return getBackend().cancelConversation(cancelConversationId);
        })
        .catch(() => {
          // Silently ignore - cancellation already happened client-side
        });

      // Delay flag reset to ensure React has flushed state updates before dequeue can fire.
      // Use setTimeout(50) instead of setTimeout(0) - the longer delay ensures React's
      // batched state updates have been fully processed before we allow the dequeue effect.
      setTimeout(() => {
        userCancelledRef.current = false;
      }, 50);

      return;
    }

    if (!streaming || interruptRequested) {
      return;
    }

    // If we're in the middle of queue cancel, set flag to restore instead of auto-send
    if (waitingForQueueCancelRef.current) {
      setRestoreQueueOnCancel(true);
      // Don't reset flags - let the cancel complete naturally
    }

    // If EAGER_CANCEL is enabled, immediately stop everything client-side first
    if (EAGER_CANCEL) {
      // Prevent multiple handleInterrupt calls while state updates are pending
      setInterruptRequested(true);

      // Set interrupted flag FIRST, before abort() triggers any async work.
      // This ensures onChunk and other guards see interrupted=true immediately.
      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(
        buffersRef.current,
        true,
        "user_interrupt",
      );

      // Mark any running subagents as interrupted. If this interrupted a
      // background reflection, also release its launch reservation so ESC does
      // not leave future reflections blocked waiting for an onComplete callback
      // that may never fire.
      interruptSubagentsAndReleaseReflection(agentId);

      // NOW abort the stream - interrupted flag is already set
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null; // Clear ref so isAgentBusy() returns false
      }

      // Set cancellation flag to prevent processConversation from starting
      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true;

      // Increment generation to mark any in-flight processConversation as stale.
      // The stale processConversation will check this and exit quietly without
      // decrementing the ref (since we reset it here).
      conversationGenerationRef.current += 1;

      // Reset the processing guard so the next message can start a new conversation.
      processingConversationRef.current = 0;

      // Stop streaming and show error message (unless tool calls were cancelled,
      // since the tool result will show "Interrupted by user")
      setStreaming(false);
      resetTrajectoryBases();
      toolResultsInFlightRef.current = false;
      setIsExecutingTool(false);
      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }
      refreshDerived();

      // Cache pending approvals, plus any auto-handled results, for the next message.
      const denialResults: ApprovalResult[] = pendingApprovals.map(
        (approval) => ({
          type: "approval" as const,
          tool_call_id: approval.toolCallId,
          approve: false,
          reason: "User interrupted the stream",
        }),
      );
      const autoHandledSnapshot = [...autoHandledResults];
      const autoDeniedSnapshot = [...autoDeniedApprovals];
      const queuedResults: ApprovalResult[] = [
        ...autoHandledSnapshot.map((ar) => ({
          type: "tool" as const,
          tool_call_id: ar.toolCallId,
          tool_return: ar.result.toolReturn,
          status: ar.result.status,
          stdout: ar.result.stdout,
          stderr: ar.result.stderr,
        })),
        ...autoDeniedSnapshot.map((ad) => ({
          type: "approval" as const,
          tool_call_id: ad.approval.toolCallId,
          approve: false,
          reason: ad.reason,
        })),
        ...denialResults,
      ];
      if (queuedResults.length > 0) {
        queueApprovalResults(queuedResults);
      }

      // Clear local approval state
      setPendingApprovals([]);
      setApprovalContexts([]);
      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);

      // Send cancel request to backend asynchronously (fire-and-forget)
      // Don't wait for it or show errors since user already got feedback
      Promise.resolve()
        .then(() => {
          const cancelConversationId =
            conversationIdRef.current === "default"
              ? agentIdRef.current
              : conversationIdRef.current;
          if (!cancelConversationId || cancelConversationId === "loading") {
            return;
          }
          return getBackend().cancelConversation(cancelConversationId);
        })
        .catch(() => {
          // Silently ignore - cancellation already happened client-side
        });

      // Reset cancellation flags after cleanup is complete.
      // Use setTimeout(50) instead of setTimeout(0) to ensure React has fully processed
      // the streaming=false state before we allow the dequeue effect to start a new conversation.
      // This prevents the "Maximum update depth exceeded" infinite render loop.
      setTimeout(() => {
        userCancelledRef.current = false;
        setInterruptRequested(false);
      }, 50);

      return;
    } else {
      setInterruptRequested(true);
      try {
        const cancelConversationId =
          conversationIdRef.current === "default"
            ? agentIdRef.current
            : conversationIdRef.current;
        if (!cancelConversationId || cancelConversationId === "loading") {
          return;
        }
        await getBackend().cancelConversation(cancelConversationId);

        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsExecutingTool(false);
        toolResultsInFlightRef.current = false;
        pendingInterruptRecoveryConversationIdRef.current =
          conversationIdRef.current;
      } catch (e) {
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(`Failed to interrupt stream: ${errorDetails}`, {
          ...extractErrorMeta(e),
          context: "stream_interrupt",
        });
        setInterruptRequested(false);
        setIsExecutingTool(false);
        toolResultsInFlightRef.current = false;
      }
    }
  }, [
    agentId,
    streaming,
    interruptRequested,
    appendError,
    isExecutingTool,
    refreshDerived,
    setStreaming,
    pendingApprovals,
    autoHandledResults,
    autoDeniedApprovals,
    queueApprovalResults,
    resetTrajectoryBases,
    abortControllerRef,
    autoAllowedExecutionRef,
    conversationGenerationRef,
    executingToolCallIdsRef,
    interruptQueuedRef,
    pendingInterruptRecoveryConversationIdRef,
    processingConversationRef,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setInterruptRequested,
    setIsExecutingTool,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    toolResultsInFlightRef,
    userCancelledRef,
  ]);

  return {
    handleInterrupt,
  };
}
