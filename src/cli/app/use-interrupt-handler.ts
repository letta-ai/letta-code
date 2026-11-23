import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  getSubagents,
  interruptActiveSubagents,
  interruptStopFailedSubagents,
} from "@/agent/subagent-state";
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

function hasActiveReflectionSubagentForAgent(
  agentId: string,
  conversationId?: string,
): boolean {
  return getSubagents().some((agent) => {
    if (agent.type.toLowerCase() !== "reflection") return false;
    if (agent.status !== "pending" && agent.status !== "running") return false;
    if (agent.parentAgentId !== agentId) return false;
    return (
      conversationId === undefined ||
      agent.parentConversationId === undefined ||
      agent.parentConversationId === conversationId
    );
  });
}

function interruptSubagentsAndReleaseReflection(
  agentId: string,
  conversationId?: string,
): void {
  const interruptedReflection = hasActiveReflectionSubagentForAgent(
    agentId,
    conversationId,
  );
  interruptActiveSubagents(INTERRUPTED_BY_USER, {
    agentId,
    conversationId,
  });
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

  const settleIfNoTurnInFlight = () => {
    if (processingConversationRef.current > 0) return;
    settleTuiInterrupt({
      userCancelledRef,
      setInterruptRequested,
      queueLength: tuiQueueRef.current?.length ?? 0,
      bumpDequeueEpoch: () => setDequeueEpoch((e) => e + 1),
    });
  };

  const interruptEscalationRef = useRef<{
    controller: AbortController | null;
    target: string | null;
  } | null>(null);

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

      conversationGenerationRef.current += 1;

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

      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(
        buffersRef.current,
        true,
        "user_interrupt",
      );

      interruptSubagentsAndReleaseReflection(
        agentId,
        conversationIdRef.current,
      );

      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }

      abortControllerRef.current?.abort();

      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true;
      tuiQueueRef.current?.pause();
      setStreaming(false);
      resetTrajectoryBases();
      setIsExecutingTool(false);
      toolResultsInFlightRef.current = false;
      refreshDerived();

      sendBackendCancel();

      settleIfNoTurnInFlight();
      return;
    }

    const abortedControllerWitness =
      abortControllerRef.current?.signal.aborted ?? false;
    if (!streaming || interruptRequested || abortedControllerWitness) {
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
      const retried = interruptStopFailedSubagents(INTERRUPTED_BY_USER, {
        agentId,
        conversationId: conversationIdRef.current,
      });
      if (retried.length > 0) {
        if (
          retried.some(
            (id) =>
              getSubagents()
                .find((agent) => agent.id === id)
                ?.type.toLowerCase() === "reflection",
          )
        ) {
          releaseReflectionLaunch(agentId);
        }
        appendError("Retrying stop of background task...", true);
      }
      return;
    }

    if (waitingForQueueCancelRef.current) {
      setRestoreQueueOnCancel(true);
    }

    if (EAGER_CANCEL) {
      latchInterruptTarget();
      setInterruptRequested(true);

      buffersRef.current.abortGeneration =
        (buffersRef.current.abortGeneration || 0) + 1;
      const toolsCancelled = markIncompleteToolsAsCancelled(
        buffersRef.current,
        true,
        "user_interrupt",
      );

      interruptSubagentsAndReleaseReflection(
        agentId,
        conversationIdRef.current,
      );

      abortControllerRef.current?.abort();

      pendingInterruptRecoveryConversationIdRef.current =
        conversationIdRef.current;
      userCancelledRef.current = true;
      tuiQueueRef.current?.pause();

      conversationGenerationRef.current += 1;

      setStreaming(false);
      resetTrajectoryBases();
      toolResultsInFlightRef.current = false;
      setIsExecutingTool(false);
      if (!toolsCancelled) {
        appendError(INTERRUPT_MESSAGE, true);
      }
      refreshDerived();

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

      setPendingApprovals([]);
      setApprovalContexts([]);
      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);

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
