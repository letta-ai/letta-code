// src/cli/app/useInterruptHandler.ts

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import { getSubagents, interruptActiveSubagents } from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import type { Buffers } from "@/cli/helpers/accumulator";
import { markIncompleteToolsAsCancelled } from "@/cli/helpers/accumulator";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { releaseReflectionLaunch } from "@/cli/helpers/reflection-launcher";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { settleTuiInterrupt } from "@/cli/helpers/tui-turn-lifecycle";
import { INTERRUPTED_BY_USER } from "@/constants";
import type { ApprovalContext } from "@/permissions/analyzer";
import type { QueueRuntime } from "@/queue/queue-runtime";

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
  setDequeueEpoch: Dispatch<SetStateAction<number>>;
  setInterruptRequested: Dispatch<SetStateAction<boolean>>;
  setIsExecutingTool: Dispatch<SetStateAction<boolean>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setRestoreQueueOnCancel: Dispatch<SetStateAction<boolean>>;
  setStreaming: (value: boolean) => void;
  streaming: boolean;
  toolAbortControllerRef: MutableRefObject<AbortController | null>;
  toolResultsInFlightRef: MutableRefObject<boolean>;
  tuiQueueRef: MutableRefObject<QueueRuntime | null>;
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
    setDequeueEpoch,
    setInterruptRequested,
    setIsExecutingTool,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setStreaming,
    streaming,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    tuiQueueRef,
    userCancelledRef,
    waitingForQueueCancelRef,
  } = ctx;

  // The interrupted turn's finally block settles the interrupt once it has
  // unwound (cancelling -> idle). If no turn is in flight there is no owner to
  // do so, so the interrupt settles immediately.
  const settleIfNoTurnInFlight = () => {
    if (processingConversationRef.current > 0) return;
    settleTuiInterrupt({
      userCancelledRef,
      setInterruptRequested,
      queueLength: tuiQueueRef.current?.length ?? 0,
      bumpDequeueEpoch: () => setDequeueEpoch((e) => e + 1),
    });
  };

  // Latched interrupt state, written synchronously on the first Esc: the
  // aborted controller is the escalation witness (a rapid second Esc can
  // arrive before React commits interruptRequested, and a stuck turn keeps
  // its controller after force-settle), and the captured target keeps the
  // escalated cancel aimed at the interrupted conversation even if a queued
  // conversation switch runs while the turn unwinds.
  const interruptEscalationRef = useRef<{
    controller: AbortController | null;
    target: string | null;
  } | null>(null);

  // Fire the backend cancel. The local interrupt already gave the user
  // feedback, but a failed backend cancel leaves the server-side run
  // executing and the next send hitting CONFLICT, so surface the failure
  // instead of swallowing it.
  const sendBackendCancel = () => {
    Promise.resolve()
      .then(() => {
        const latched = interruptEscalationRef.current;
        const cancelConversationId =
          latched && latched.controller === abortControllerRef.current
            ? latched.target
            : conversationIdRef.current === "default"
              ? agentIdRef.current
              : conversationIdRef.current;
        if (!cancelConversationId || cancelConversationId === "loading") {
          return;
        }
        return getBackend().cancelConversation(cancelConversationId);
      })
      .catch(() => {
        appendError(
          "Interrupt acknowledged locally, but the backend cancel request failed — the run may still be executing server-side.",
          true,
        );
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects; .current is read dynamically when interrupt fires.
  const handleInterrupt = useCallback(async () => {
    // If we're executing client-side tools, abort them AND the main stream
    const hasTrackedTools =
      executingToolCallIdsRef.current.length > 0 ||
      autoAllowedExecutionRef.current?.results;
    const latchInterruptTarget = () => {
      interruptEscalationRef.current = {
        controller: abortControllerRef.current,
        target:
          conversationIdRef.current === "default"
            ? agentIdRef.current
            : conversationIdRef.current,
      };
    };
    if (
      isExecutingTool &&
      toolAbortControllerRef.current &&
      hasTrackedTools &&
      !toolResultsInFlightRef.current
    ) {
      latchInterruptTarget();
      toolAbortControllerRef.current.abort();

      // Mark any in-flight conversation as stale, consistent with EAGER_CANCEL.
      // Increment before tagging queued results so they are tied to the post-interrupt state.
      // The stale turn keeps its processing count and abort controller until its
      // finally block runs; that block settles the interrupt.
      conversationGenerationRef.current += 1;

      // Mark the interrupt in-flight until the stale turn unwinds, matching
      // EAGER_CANCEL: a second Esc in this window must reach the escalation
      // branch below (InputRich only forwards while streaming or requested).
      setInterruptRequested(true);

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

      // Abort only. The turn's finally block clears the controller so nothing
      // can dequeue a replacement turn while cancellation unwinds.
      abortControllerRef.current?.abort();

      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true; // Prevent dequeue
      tuiQueueRef.current?.pause(); // Park queued user messages until resume
      setStreaming(false);
      resetTrajectoryBases();
      setIsExecutingTool(false);
      toolResultsInFlightRef.current = false;
      refreshDerived();

      // Send cancel request to backend (fire-and-forget).
      // Without this, the backend stays in requires_approval state after tool interrupt,
      // causing CONFLICT on the next user message.
      sendBackendCancel();

      settleIfNoTurnInFlight();
      return;
    }

    const abortedControllerWitness =
      abortControllerRef.current?.signal.aborted ?? false;
    if (!streaming || interruptRequested || abortedControllerWitness) {
      // Second+ Esc while the first interrupt is still unwinding: escalate.
      // Re-fire the backend cancel (the first attempt may have failed) and
      // settle the interrupt immediately so the UI is never wedged waiting
      // for a turn that is not observing the abort. The first Esc aborts the
      // controller synchronously, so signal.aborted witnesses an in-flight
      // interrupt at the outer gate too: a rapid second Esc before React
      // commits (stale closure still reads streaming) must reach this branch,
      // as must a post-force-settle Esc while a stuck turn owns its controller.
      if (interruptRequested || abortedControllerWitness) {
        abortControllerRef.current?.abort();
        sendBackendCancel();
        appendError(
          "Interrupt forced; the turn will stop as soon as it observes the abort.",
          true,
        );
        settleTuiInterrupt({
          userCancelledRef,
          setInterruptRequested,
          queueLength: tuiQueueRef.current?.length ?? 0,
          bumpDequeueEpoch: () => setDequeueEpoch((e) => e + 1),
        });
      }
      return;
    }

    // If we're in the middle of queue cancel, set flag to restore instead of auto-send
    if (waitingForQueueCancelRef.current) {
      setRestoreQueueOnCancel(true);
      // Don't reset flags - let the cancel complete naturally
    }

    // If EAGER_CANCEL is enabled, immediately stop everything client-side first
    if (EAGER_CANCEL) {
      latchInterruptTarget();
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

      // NOW abort the stream - interrupted flag is already set. The controller
      // stays set until the turn's finally block clears it: isAgentBusy() must
      // report busy while the cancelled turn unwinds.
      abortControllerRef.current?.abort();

      // Set cancellation flag to prevent processConversation from starting
      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true;
      // Park the user's queued messages: Esc stops the turn and holds them
      // until Enter on an empty input or the next message. System items
      // (task notifications, cron, mod continuations) still drain on settle.
      tuiQueueRef.current?.pause();

      // Increment generation to mark any in-flight processConversation as stale.
      // The stale turn keeps its processing count until its finally block runs;
      // that block settles the interrupt (cancelling -> idle) and wakes dequeue.
      conversationGenerationRef.current += 1;

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

      // Send cancel request to backend asynchronously (fire-and-forget).
      // Failures are surfaced so a server-side run isn't left executing
      // while the client believes it stopped.
      sendBackendCancel();

      settleIfNoTurnInFlight();
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
    setDequeueEpoch,
    setInterruptRequested,
    setIsExecutingTool,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    toolResultsInFlightRef,
    tuiQueueRef,
    userCancelledRef,
  ]);

  return {
    handleInterrupt,
  };
}
