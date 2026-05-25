// src/cli/app/useApprovalFlow.ts

import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
} from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import type { SessionStats } from "@/agent/stats";
import {
  type Buffers,
  markIncompleteToolsAsCancelled,
  onChunk,
  setToolCallsRunning,
} from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { parseMemoryPreference } from "@/cli/helpers/memory-reminder";
import {
  buildQueuedContentParts,
  buildQueuedUserText,
  getQueuedNotificationSummaries,
} from "@/cli/helpers/queued-message-parts";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { flushEligibleLinesBeforeReentry } from "@/cli/helpers/subagent-turn-start";
import { getRandomThinkingVerb } from "@/cli/helpers/thinking-messages";
import type { ApprovalContext } from "@/permissions/analyzer";
import type { PermissionMode } from "@/permissions/mode";
import {
  analyzeToolApproval,
  checkToolPermission,
  savePermissionRule,
  type ToolExecutionResult,
} from "@/tools/manager";
import type { PreparedScopeToolContext } from "@/tools/toolset";
import { debugLog } from "@/utils/debug";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

import { buildApprovalBatchKey } from "./approval-diffs";
import { getQuestionsFromApproval } from "./approval-questions";
import { extractErrorMeta } from "./errors";
import { appendOptimisticUserLine, createClientOtid } from "./ids";
import { sendDesktopNotification } from "./notifications";
import type {
  AppCommandRunner,
  AppendError,
  AppLoadingState,
  ApprovalDecision,
  AutoDeniedApproval,
  AutoHandledToolResult,
  ProcessConversation,
  QueueApprovalResults,
  QueuedApprovalMetadata,
} from "./types";

type RestoredApprovalRecoveryState = {
  batchKey: string | null;
  generation: number;
  status: "idle" | "running" | "completed";
};

type ApprovalFlowContext = {
  abortControllerRef: MutableRefObject<AbortController | null>;
  agentId: string;
  appendError: AppendError;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  approvalContexts: ApprovalContext[];
  approvalToolContextIdRef: MutableRefObject<string | null>;
  approvalResults: ApprovalDecision[];
  autoDeniedApprovals: AutoDeniedApproval[];
  autoHandledResults: AutoHandledToolResult[];
  buffersRef: MutableRefObject<Buffers>;
  clearApprovalToolContext: () => void;
  closeTrajectorySegment: () => void;
  commandRunner: AppCommandRunner;
  commitEligibleLines: (
    buffers: Buffers,
    opts?: { deferToolCalls?: boolean },
  ) => void;
  consumeQueuedMessages: () => QueuedMessage[] | null;
  queueModeRef: MutableRefObject<"immediate" | "defer">;
  conversationGenerationRef: MutableRefObject<number>;
  conversationId: string;
  conversationIdRef: MutableRefObject<string>;
  executingToolCallIdsRef: MutableRefObject<string[]>;
  interruptQueuedRef: MutableRefObject<boolean>;
  isExecutingTool: boolean;
  loadingState: AppLoadingState;
  openTrajectorySegment: () => void;
  pendingApprovals: ApprovalRequest[];
  precomputedDiffsRef: MutableRefObject<Map<string, AdvancedDiffSuccess>>;
  prepareScopedToolExecutionContext: (
    overrideModel?: string | null,
  ) => Promise<PreparedScopeToolContext>;
  processConversation: ProcessConversation;
  queueApprovalResults: QueueApprovalResults;
  queueSnapshotRef: MutableRefObject<QueuedMessage[]>;
  queuedApprovalMetadataRef: MutableRefObject<QueuedApprovalMetadata | null>;
  queuedApprovalResultsRef: MutableRefObject<ApprovalResult[] | null>;
  refreshDerived: () => void;
  restoredApprovalRecoveryRef: MutableRefObject<RestoredApprovalRecoveryState>;
  sessionStatsRef: MutableRefObject<SessionStats>;
  setApprovalContexts: Dispatch<SetStateAction<ApprovalContext[]>>;
  setApprovalResults: Dispatch<SetStateAction<ApprovalDecision[]>>;
  setAutoDeniedApprovals: Dispatch<SetStateAction<AutoDeniedApproval[]>>;
  setAutoHandledResults: Dispatch<SetStateAction<AutoHandledToolResult[]>>;
  setIsExecutingTool: Dispatch<SetStateAction<boolean>>;
  setNeedsEagerApprovalCheck: Dispatch<SetStateAction<boolean>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setStreaming: (value: boolean) => void;
  setThinkingMessage: Dispatch<SetStateAction<string>>;
  setUiPermissionMode: (mode: PermissionMode) => void;
  startupApproval: ApprovalRequest | null;
  startupApprovals: ApprovalRequest[];
  syncTrajectoryElapsedBase: () => void;
  tempModelOverrideRef: MutableRefObject<string | null>;
  toolAbortControllerRef: MutableRefObject<AbortController | null>;
  toolResultsInFlightRef: MutableRefObject<boolean>;
  updateStreamingOutput: (
    toolCallId: string,
    chunk: string,
    isStderr?: boolean,
  ) => void;
  userCancelledRef: MutableRefObject<boolean>;
  waitingForQueueCancelRef: MutableRefObject<boolean>;
};

export function useApprovalFlow(ctx: ApprovalFlowContext) {
  const {
    abortControllerRef,
    agentId,
    appendError,
    appendTaskNotificationEvents,
    approvalContexts,
    approvalResults,
    approvalToolContextIdRef,
    autoDeniedApprovals,
    autoHandledResults,
    buffersRef,
    clearApprovalToolContext,
    closeTrajectorySegment,
    commandRunner,
    commitEligibleLines,
    consumeQueuedMessages,
    queueModeRef,
    conversationGenerationRef,
    conversationId,
    conversationIdRef,
    executingToolCallIdsRef,
    interruptQueuedRef,
    isExecutingTool,
    loadingState,
    openTrajectorySegment,
    pendingApprovals,
    precomputedDiffsRef,
    prepareScopedToolExecutionContext,
    processConversation,
    queueApprovalResults,
    queueSnapshotRef,
    queuedApprovalMetadataRef,
    queuedApprovalResultsRef,
    refreshDerived,
    restoredApprovalRecoveryRef,
    sessionStatsRef,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setIsExecutingTool,
    setNeedsEagerApprovalCheck,
    setPendingApprovals,
    setStreaming,
    setThinkingMessage,
    setUiPermissionMode,
    startupApproval,
    startupApprovals,
    syncTrajectoryElapsedBase,
    tempModelOverrideRef,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    updateStreamingOutput,
    userCancelledRef,
    waitingForQueueCancelRef,
  } = ctx;

  const restorePendingApprovalUi = useCallback(
    async (
      approvals: ApprovalRequest[],
      contexts?: ApprovalContext[],
    ): Promise<void> => {
      setPendingApprovals(approvals);

      if (contexts) {
        setApprovalContexts(contexts);
        return;
      }

      try {
        const analyzedContexts = await Promise.all(
          approvals.map(async (approval) => {
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              approval.toolArgs,
              {},
            );
            return await analyzeToolApproval(approval.toolName, parsedArgs);
          }),
        );
        setApprovalContexts(analyzedContexts);
      } catch (error) {
        debugLog(
          "approvals",
          "Failed to analyze restored approvals: %O",
          error,
        );
        setApprovalContexts([]);
      }
    },
    [setApprovalContexts, setPendingApprovals],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable objects; .current is read dynamically at call time.
  const recoverRestoredPendingApprovals = useCallback(
    async (
      approvals: ApprovalRequest[],
      options: { notifyOnManualApproval?: boolean } = {},
    ): Promise<void> => {
      if (approvals.length === 0) {
        return;
      }

      const generationAtStart = conversationGenerationRef.current;
      const batchKey = buildApprovalBatchKey(approvals);
      const currentRecovery = restoredApprovalRecoveryRef.current;
      if (
        currentRecovery.batchKey === batchKey &&
        currentRecovery.generation === generationAtStart &&
        currentRecovery.status !== "idle"
      ) {
        return;
      }

      restoredApprovalRecoveryRef.current = {
        batchKey,
        generation: generationAtStart,
        status: "running",
      };

      const queuedMetadata = queuedApprovalMetadataRef.current;
      const hasQueuedRealResults =
        queuedApprovalResultsRef.current !== null &&
        queuedApprovalResultsRef.current.length > 0 &&
        queuedMetadata?.conversationId === conversationIdRef.current &&
        queuedMetadata.generation === generationAtStart;

      setApprovalResults([]);
      setAutoHandledResults([]);
      setAutoDeniedApprovals([]);
      setApprovalContexts([]);
      setPendingApprovals([]);

      try {
        if (conversationGenerationRef.current !== generationAtStart) {
          restoredApprovalRecoveryRef.current = {
            batchKey,
            generation: generationAtStart,
            status: "completed",
          };
          return;
        }

        if (hasQueuedRealResults) {
          setNeedsEagerApprovalCheck(false);
          restoredApprovalRecoveryRef.current = {
            batchKey,
            generation: generationAtStart,
            status: "completed",
          };
          return;
        }

        await restorePendingApprovalUi(approvals);
        setNeedsEagerApprovalCheck(false);
        if (options.notifyOnManualApproval) {
          sendDesktopNotification("Approval needed");
        }

        restoredApprovalRecoveryRef.current = {
          batchKey,
          generation: generationAtStart,
          status: "completed",
        };
      } catch (error) {
        debugLog(
          "approvals",
          "Failed to restore pending approval UI: %O",
          error,
        );
        await restorePendingApprovalUi(approvals);
        setNeedsEagerApprovalCheck(false);
        setAutoHandledResults([]);
        setAutoDeniedApprovals([]);
        sendDesktopNotification("Approval needed");
        restoredApprovalRecoveryRef.current = {
          batchKey,
          generation: generationAtStart,
          status: "completed",
        };
      }
    },
    [
      restorePendingApprovalUi,
      restoredApprovalRecoveryRef,
      setApprovalContexts,
      setApprovalResults,
      setAutoDeniedApprovals,
      setAutoHandledResults,
      setNeedsEagerApprovalCheck,
      setPendingApprovals,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the intentional reset trigger; generation ref is read dynamically.
  useEffect(() => {
    void conversationId;
    restoredApprovalRecoveryRef.current = {
      batchKey: null,
      generation: conversationGenerationRef.current,
      status: "idle",
    };
  }, [conversationId, restoredApprovalRecoveryRef]);

  // Restore pending approval from startup when ready.
  useEffect(() => {
    const approvals =
      startupApprovals?.length > 0
        ? startupApprovals
        : startupApproval
          ? [startupApproval]
          : [];

    if (loadingState === "ready" && approvals.length > 0) {
      void recoverRestoredPendingApprovals(approvals);
    }
  }, [
    loadingState,
    recoverRestoredPendingApprovals,
    startupApproval,
    startupApprovals,
  ]);

  // Helper to send all approval results when done
  // biome-ignore lint/correctness/useExhaustiveDependencies: approval refs are stable objects; .current is read dynamically during the approval send.
  const sendAllResults = useCallback(
    async (
      additionalDecision?:
        | { type: "approve"; approval: ApprovalRequest }
        | { type: "deny"; approval: ApprovalRequest; reason: string },
    ) => {
      try {
        // Don't send results if user has already cancelled
        if (
          userCancelledRef.current ||
          abortControllerRef.current?.signal.aborted
        ) {
          setStreaming(false);
          setIsExecutingTool(false);
          setPendingApprovals([]);
          setApprovalContexts([]);
          setApprovalResults([]);
          setAutoHandledResults([]);
          setAutoDeniedApprovals([]);
          return;
        }

        // Snapshot current state before clearing dialog
        const approvalResultsSnapshot = [...approvalResults];
        const autoHandledSnapshot = [...autoHandledResults];
        const autoDeniedSnapshot = [...autoDeniedApprovals];
        const pendingSnapshot = [...pendingApprovals];

        // Clear dialog state immediately so UI updates right away
        setPendingApprovals([]);
        setApprovalContexts([]);
        setApprovalResults([]);
        setAutoHandledResults([]);
        setAutoDeniedApprovals([]);

        // Show "thinking" state and lock input while executing approved tools client-side
        setStreaming(true);
        openTrajectorySegment();
        // Ensure interrupted flag is cleared for this execution
        buffersRef.current.interrupted = false;

        const approvalAbortController = new AbortController();
        toolAbortControllerRef.current = approvalAbortController;

        // Combine all decisions using snapshots
        const allDecisions = [
          ...approvalResultsSnapshot,
          ...(additionalDecision ? [additionalDecision] : []),
        ];

        const approvedDecisions = allDecisions.filter(
          (
            decision,
          ): decision is {
            type: "approve";
            approval: ApprovalRequest;
            precomputedResult?: ToolExecutionResult;
          } => decision.type === "approve",
        );
        const runningDecisions = approvedDecisions.filter(
          (decision) => !decision.precomputedResult,
        );

        executingToolCallIdsRef.current = runningDecisions.map(
          (decision) => decision.approval.toolCallId,
        );

        // Set phase to "running" for all approved tools
        if (runningDecisions.length > 0) {
          setToolCallsRunning(
            buffersRef.current,
            runningDecisions.map((d) => d.approval.toolCallId),
          );
        }
        refreshDerived();

        // Execute approved tools and format results using shared function
        const { executeApprovalBatch } = await import(
          "@/agent/approval-execution"
        );
        sessionStatsRef.current.startTrajectory();
        const toolRunStart = performance.now();
        let executedResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
        try {
          const approvalToolContextId =
            approvalToolContextIdRef.current ??
            (
              await prepareScopedToolExecutionContext(
                tempModelOverrideRef.current ?? undefined,
              )
            ).preparedToolContext.contextId;
          executedResults = await executeApprovalBatch(
            allDecisions,
            (chunk) => {
              onChunk(buffersRef.current, chunk);
              // Also log errors to the UI error display
              if (
                chunk.status === "error" &&
                chunk.message_type === "tool_return_message"
              ) {
                const isToolError = chunk.tool_return?.startsWith(
                  "Error executing tool:",
                );
                if (isToolError) {
                  appendError(chunk.tool_return, {
                    errorType: "tool_execution_error",
                    context: "tool_execution",
                  });
                }
              }
              // Flush UI so completed tools show up while the batch continues
              refreshDerived();
            },
            {
              abortSignal: approvalAbortController.signal,
              onStreamingOutput: updateStreamingOutput,
              toolContextId: approvalToolContextId,
            },
          );
        } finally {
          const toolRunMs = performance.now() - toolRunStart;
          sessionStatsRef.current.accumulateTrajectory({
            localToolMs: toolRunMs,
          });
        }

        // Combine with auto-handled and auto-denied results using snapshots
        const allResults = [
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
          ...executedResults,
        ];

        // Dev-only validation: ensure outgoing IDs match expected IDs (using snapshots)
        if (process.env.NODE_ENV !== "production") {
          // Include ALL tool call IDs: auto-handled, auto-denied, and pending approvals
          const expectedIds = new Set([
            ...autoHandledSnapshot.map((ar) => ar.toolCallId),
            ...autoDeniedSnapshot.map((ad) => ad.approval.toolCallId),
            ...pendingSnapshot.map((a) => a.toolCallId),
          ]);
          const sendingIds = new Set(
            allResults.map((r) => r.tool_call_id).filter(Boolean),
          );

          const setsEqual = (a: Set<string>, b: Set<string>) =>
            a.size === b.size && [...a].every((id) => b.has(id));

          if (!setsEqual(expectedIds, sendingIds)) {
            debugLog(
              "approvals",
              "[BUG] Approval ID mismatch detected. Expected: %O, Sending: %O",
              Array.from(expectedIds),
              Array.from(sendingIds),
            );
            throw new Error(
              "Approval ID mismatch - refusing to send mismatched IDs",
            );
          }
        }

        // Rotate to a new thinking message
        setThinkingMessage(getRandomThinkingVerb());
        refreshDerived();

        const wasAborted = approvalAbortController.signal.aborted;
        // Check if user cancelled via ESC. We use wasAborted (toolAbortController was aborted)
        // as the primary signal, plus userCancelledRef for cancellations that happen just before
        // tools complete. Note: we can't use `abortControllerRef.current === null` because
        // abortControllerRef is also null in the normal approval flow (no stream running).
        const userCancelled = userCancelledRef.current;

        if (wasAborted || userCancelled) {
          // Queue results to send alongside the next user message so the backend
          // doesn't keep requesting the same approvals after an interrupt.
          if (!interruptQueuedRef.current) {
            queueApprovalResults(allResults as ApprovalResult[]);
          }
          setStreaming(false);
          closeTrajectorySegment();
          syncTrajectoryElapsedBase();

          // Reset queue-cancel flag so dequeue effect can fire
          waitingForQueueCancelRef.current = false;
          queueSnapshotRef.current = [];
        } else {
          const queuedItemsToAppend =
            queueModeRef.current === "immediate"
              ? consumeQueuedMessages()
              : null;
          const queuedNotifications = queuedItemsToAppend
            ? getQueuedNotificationSummaries(queuedItemsToAppend)
            : [];
          const hadNotifications =
            appendTaskNotificationEvents(queuedNotifications);
          const input: Array<MessageCreate | ApprovalCreate> = [
            {
              type: "approval",
              approvals: allResults as ApprovalResult[],
              otid: createClientOtid(),
            },
          ];
          if (queuedItemsToAppend && queuedItemsToAppend.length > 0) {
            const queuedUserText = buildQueuedUserText(queuedItemsToAppend);
            const queuedUserOtid = createClientOtid();
            appendOptimisticUserLine(
              buffersRef.current,
              queuedUserText,
              queuedUserOtid,
            );
            input.push({
              type: "message",
              role: "user",
              content: buildQueuedContentParts(queuedItemsToAppend),
              otid: queuedUserOtid,
            });
            refreshDerived();
          } else if (hadNotifications) {
            refreshDerived();
          }
          // Flush finished items synchronously before reentry. This avoids a
          // race where deferred non-Task commits delay Task grouping while the
          // reentry path continues.
          flushEligibleLinesBeforeReentry(
            commitEligibleLines,
            buffersRef.current,
          );
          toolResultsInFlightRef.current = true;
          await processConversation(input, { allowReentry: true });
          toolResultsInFlightRef.current = false;

          // Clear any stale queued results from previous interrupts.
          // This approval flow supersedes any previously queued results - if we don't
          // clear them here, they persist with matching generation and get sent on the
          // next onSubmit, causing "Invalid tool call IDs" errors.
          queueApprovalResults(null);
        }
      } catch (error) {
        markIncompleteToolsAsCancelled(
          buffersRef.current,
          true,
          "stream_error",
        );
        const errorDetails = formatErrorDetails(error, agentId);
        appendError(errorDetails, {
          ...extractErrorMeta(error),
          context: "approval_send",
        });
        setStreaming(false);
        closeTrajectorySegment();
        syncTrajectoryElapsedBase();
        refreshDerived();
      } finally {
        // Always release the execution guard, even if an error occurred
        clearApprovalToolContext();
        setIsExecutingTool(false);
        toolAbortControllerRef.current = null;
        executingToolCallIdsRef.current = [];
        interruptQueuedRef.current = false;
        toolResultsInFlightRef.current = false;
      }
    },
    [
      agentId,
      approvalResults,
      autoHandledResults,
      autoDeniedApprovals,
      pendingApprovals,
      processConversation,
      refreshDerived,
      appendError,
      setStreaming,
      updateStreamingOutput,
      queueApprovalResults,
      consumeQueuedMessages,
      appendTaskNotificationEvents,
      clearApprovalToolContext,
      syncTrajectoryElapsedBase,
      closeTrajectorySegment,
      openTrajectorySegment,
      commitEligibleLines,
      prepareScopedToolExecutionContext,
      executingToolCallIdsRef,
      interruptQueuedRef,
      queueSnapshotRef,
      setApprovalContexts,
      setApprovalResults,
      setAutoDeniedApprovals,
      setAutoHandledResults,
      setIsExecutingTool,
      setPendingApprovals,
      setThinkingMessage,
      toolAbortControllerRef,
      toolResultsInFlightRef,
      waitingForQueueCancelRef,
    ],
  );

  // Handle approval callbacks - sequential review
  // biome-ignore lint/correctness/useExhaustiveDependencies: diff cache ref is stable; .current is read dynamically.
  const handleApproveCurrent = useCallback(
    async (diffs?: Map<string, AdvancedDiffSuccess>) => {
      if (isExecutingTool) return;

      const currentIndex = approvalResults.length;
      const currentApproval = pendingApprovals[currentIndex];

      if (!currentApproval) return;

      // Store precomputed diffs before execution
      if (diffs) {
        for (const [key, diff] of diffs) {
          precomputedDiffsRef.current.set(key, diff);
        }
      }

      setIsExecutingTool(true);

      try {
        // Store approval decision (don't execute yet - batch execute after all approvals)
        const decision = {
          type: "approve" as const,
          approval: currentApproval,
        };

        // Check if we're done with all approvals
        if (currentIndex + 1 >= pendingApprovals.length) {
          // All approvals collected, execute and send to backend
          // sendAllResults owns the lock release via its finally block
          await sendAllResults(decision);
        } else {
          // Not done yet, store decision and show next approval
          setApprovalResults((prev) => [...prev, decision]);
          setIsExecutingTool(false);
        }
      } catch (e) {
        markIncompleteToolsAsCancelled(
          buffersRef.current,
          true,
          "stream_error",
        );
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          context: "approval_send",
        });
        setStreaming(false);
        setIsExecutingTool(false);
        refreshDerived();
      }
    },
    [
      agentId,
      pendingApprovals,
      approvalResults,
      sendAllResults,
      appendError,
      isExecutingTool,
      refreshDerived,
      setStreaming,
      setApprovalResults,
      setIsExecutingTool,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: approval execution refs are stable; .current is read dynamically.
  const handleApproveAlways = useCallback(
    async (
      scope?: "project" | "session",
      diffs?: Map<string, AdvancedDiffSuccess>,
    ) => {
      if (isExecutingTool) return;

      if (pendingApprovals.length === 0 || approvalContexts.length === 0)
        return;

      const currentIndex = approvalResults.length;
      const approvalContext = approvalContexts[currentIndex];
      const currentApproval = pendingApprovals[currentIndex];
      if (!approvalContext || !currentApproval) return;

      const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
        currentApproval.toolArgs,
        {},
      );
      const latestApprovalContext = await analyzeToolApproval(
        currentApproval.toolName,
        parsedArgs,
      );
      const rule = latestApprovalContext.recommendedRule;
      const actualScope = scope || latestApprovalContext.defaultScope;

      if (!latestApprovalContext.allowPersistence || !rule) {
        commandRunner
          .start("/approve-always", "Adding permission...")
          .fail("This approval cannot be persisted.");
        return;
      }

      const cmd = commandRunner.start(
        "/approve-always",
        "Adding permission...",
      );

      if (rule === "Edit(**)" && actualScope === "session") {
        setUiPermissionMode("acceptEdits");
        cmd.finish("Permission mode set to acceptEdits (session only)", true);
      } else {
        // Save the permission rule
        try {
          await savePermissionRule(rule, "allow", actualScope);
        } catch (error) {
          const errorDetails = formatErrorDetails(error, agentId);
          cmd.fail(`Failed to add permission: ${errorDetails}`);
          return;
        }

        // Show confirmation in transcript
        const scopeText =
          actualScope === "session" ? " (session only)" : " (project)";
        cmd.finish(`Added permission: ${rule}${scopeText}`, true);
      }

      // Re-check remaining approvals against the newly saved permission
      // This allows subsequent approvals that match the new rule to be auto-allowed
      const remainingApprovals = pendingApprovals.slice(currentIndex + 1);
      if (remainingApprovals.length > 0) {
        const recheckResults = await Promise.all(
          remainingApprovals.map(async (approval) => {
            const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
              approval.toolArgs,
              {},
            );
            const permission = await checkToolPermission(
              approval.toolName,
              parsedArgs,
            );
            return { approval, permission };
          }),
        );

        const nowAutoAllowed = recheckResults.filter(
          (r) => r.permission.decision === "allow",
        );
        const stillNeedAsking = recheckResults.filter(
          (r) => r.permission.decision === "ask",
        );

        // Only auto-handle if ALL remaining are now allowed
        // (avoids complex state synchronization issues with partial batches)
        if (stillNeedAsking.length === 0 && nowAutoAllowed.length > 0) {
          const currentApproval = pendingApprovals[currentIndex];
          if (!currentApproval) return;

          // Store diffs before execution
          if (diffs) {
            for (const [key, diff] of diffs) {
              precomputedDiffsRef.current.set(key, diff);
            }
          }

          setIsExecutingTool(true);

          // Snapshot current state BEFORE clearing (critical for ID matching!)
          // This must include ALL previous decisions, auto-handled, and auto-denied
          const approvalResultsSnapshot = [...approvalResults];
          const autoHandledSnapshot = [...autoHandledResults];
          const autoDeniedSnapshot = [...autoDeniedApprovals];

          // Build ALL decisions: previous + current + auto-allowed remaining
          const allDecisions: Array<
            | { type: "approve"; approval: ApprovalRequest }
            | { type: "deny"; approval: ApprovalRequest; reason: string }
          > = [
            ...approvalResultsSnapshot, // Include decisions from previous rounds
            { type: "approve", approval: currentApproval },
            ...nowAutoAllowed.map((r) => ({
              type: "approve" as const,
              approval: r.approval,
            })),
          ];

          // Clear dialog state immediately
          setPendingApprovals([]);
          setApprovalContexts([]);
          setApprovalResults([]);
          setAutoHandledResults([]);
          setAutoDeniedApprovals([]);

          setStreaming(true);
          openTrajectorySegment();
          buffersRef.current.interrupted = false;

          // Set phase to "running" for all approved tools
          setToolCallsRunning(
            buffersRef.current,
            allDecisions
              .filter((d) => d.type === "approve")
              .map((d) => d.approval.toolCallId),
          );
          refreshDerived();

          try {
            // Execute ALL decisions together
            const { executeApprovalBatch } = await import(
              "@/agent/approval-execution"
            );
            const approvalToolContextId =
              approvalToolContextIdRef.current ??
              (
                await prepareScopedToolExecutionContext(
                  tempModelOverrideRef.current ?? undefined,
                )
              ).preparedToolContext.contextId;
            const executedResults = await executeApprovalBatch(
              allDecisions,
              (chunk) => {
                onChunk(buffersRef.current, chunk);
                refreshDerived();
              },
              {
                onStreamingOutput: updateStreamingOutput,
                toolContextId: approvalToolContextId,
              },
            );

            // Combine with auto-handled and auto-denied results (from initial check)
            const allResults = [
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
              ...executedResults,
            ];

            setThinkingMessage(getRandomThinkingVerb());
            refreshDerived();

            // Continue conversation with all results
            await processConversation([
              {
                type: "approval",
                approvals: allResults as ApprovalResult[],
                otid: randomUUID(),
              },
            ]);
          } catch (error) {
            markIncompleteToolsAsCancelled(
              buffersRef.current,
              true,
              "stream_error",
            );
            const errorDetails = formatErrorDetails(error, agentId);
            appendError(errorDetails, {
              ...extractErrorMeta(error),
              context: "approval_send",
            });
            setStreaming(false);
            closeTrajectorySegment();
            syncTrajectoryElapsedBase();
            refreshDerived();
          } finally {
            setIsExecutingTool(false);
          }
          return; // Don't call handleApproveCurrent - we handled everything
        }
      }

      // Fallback: proceed with normal flow (will prompt for remaining approvals)
      await handleApproveCurrent(diffs);
    },
    [
      agentId,
      commandRunner,
      approvalResults,
      approvalContexts,
      pendingApprovals,
      autoHandledResults,
      autoDeniedApprovals,
      handleApproveCurrent,
      processConversation,
      refreshDerived,
      appendError,
      isExecutingTool,
      setStreaming,
      setUiPermissionMode,
      openTrajectorySegment,
      closeTrajectorySegment,
      syncTrajectoryElapsedBase,
      prepareScopedToolExecutionContext,
      updateStreamingOutput,
      setApprovalContexts,
      setApprovalResults,
      setAutoDeniedApprovals,
      setAutoHandledResults,
      setIsExecutingTool,
      setPendingApprovals,
      setThinkingMessage,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: buffersRef is stable; .current is read dynamically.
  const handleDenyCurrent = useCallback(
    async (reason: string) => {
      if (isExecutingTool) return;

      const currentIndex = approvalResults.length;
      const currentApproval = pendingApprovals[currentIndex];

      if (!currentApproval) return;

      setIsExecutingTool(true);

      try {
        // Store denial decision
        const decision = {
          type: "deny" as const,
          approval: currentApproval,
          reason: reason || "User denied the tool execution",
        };

        // Check if we're done with all approvals
        if (currentIndex + 1 >= pendingApprovals.length) {
          // All approvals collected, execute and send to backend
          // sendAllResults owns the lock release via its finally block
          setThinkingMessage(getRandomThinkingVerb());
          await sendAllResults(decision);
        } else {
          // Not done yet, store decision and show next approval
          setApprovalResults((prev) => [...prev, decision]);
          setIsExecutingTool(false);
        }
      } catch (e) {
        markIncompleteToolsAsCancelled(
          buffersRef.current,
          true,
          "stream_error",
        );
        const errorDetails = formatErrorDetails(e, agentId);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          context: "approval_send",
        });
        setStreaming(false);
        setIsExecutingTool(false);
        refreshDerived();
      }
    },
    [
      agentId,
      pendingApprovals,
      approvalResults,
      sendAllResults,
      appendError,
      isExecutingTool,
      refreshDerived,
      setStreaming,
      setApprovalResults,
      setIsExecutingTool,
      setThinkingMessage,
    ],
  );

  // Cancel all pending approvals - queue denials to send with next message
  // Similar to interrupt flow during tool execution
  // biome-ignore lint/correctness/useExhaustiveDependencies: buffersRef is stable; .current is read dynamically.
  const handleCancelApprovals = useCallback(() => {
    if (pendingApprovals.length === 0) return;

    // Create denial results for all pending approvals and queue for next message
    const denialResults = pendingApprovals.map((approval) => ({
      type: "approval" as const,
      tool_call_id: approval.toolCallId,
      approve: false,
      reason: "User cancelled the approval",
    }));
    queueApprovalResults(denialResults);

    // Mark the pending approval tool calls as cancelled in the buffers
    markIncompleteToolsAsCancelled(buffersRef.current, true, "approval_cancel");
    refreshDerived();

    // Clear all approval state
    setPendingApprovals([]);
    setApprovalContexts([]);
    setApprovalResults([]);
    setAutoHandledResults([]);
    setAutoDeniedApprovals([]);
  }, [
    pendingApprovals,
    refreshDerived,
    queueApprovalResults,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setPendingApprovals,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: buffersRef is stable; .current is read dynamically.
  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      const currentIndex = approvalResults.length;
      const approval = pendingApprovals[currentIndex];
      if (!approval) return;

      const isLast = currentIndex + 1 >= pendingApprovals.length;

      // Get questions from approval args
      const questions = getQuestionsFromApproval(approval);

      // Check for memory preference question and update setting
      parseMemoryPreference(questions, answers, agentId);

      // Format the answer string like Claude Code does
      // Filter out malformed questions (LLM might send invalid data)
      const answerParts = questions
        .filter((q) => q.question)
        .map((q) => {
          const answer = answers[q.question] || "";
          return `"${q.question}"="${answer}"`;
        });
      const toolReturn = `User has answered your questions: ${answerParts.join(", ")}. You can now continue with the user's answers in mind.`;

      const precomputedResult: ToolExecutionResult = {
        toolReturn,
        status: "success",
      };

      // Update buffers with tool return
      onChunk(buffersRef.current, {
        message_type: "tool_return_message",
        id: "dummy",
        date: new Date().toISOString(),
        tool_call_id: approval.toolCallId,
        tool_return: toolReturn,
        status: "success",
        stdout: null,
        stderr: null,
      });

      setThinkingMessage(getRandomThinkingVerb());
      refreshDerived();

      const decision = {
        type: "approve" as const,
        approval,
        precomputedResult,
      };

      if (isLast) {
        setIsExecutingTool(true);
        await sendAllResults(decision);
      } else {
        setApprovalResults((prev) => [...prev, decision]);
      }
    },
    [
      pendingApprovals,
      approvalResults,
      sendAllResults,
      refreshDerived,
      agentId,
      setApprovalResults,
      setIsExecutingTool,
      setThinkingMessage,
    ],
  );

  // Live area shows only in-progress items
  return {
    recoverRestoredPendingApprovals,
    handleApproveCurrent,
    handleApproveAlways,
    handleDenyCurrent,
    handleCancelApprovals,
    handleQuestionSubmit,
  };
}
