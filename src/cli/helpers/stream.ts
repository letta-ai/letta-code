import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { actingUserRequestOptions } from "@/agent/acting-user";
import {
  getStreamRequestContext,
  getStreamRequestStartTime,
} from "@/agent/message";
import {
  type ConversationMessageStreamBody,
  getBackend,
  type RunMessageStreamBody,
  type RunRetrieveOptions,
} from "@/backend";
import {
  clearLastSDKDiagnostic,
  consumeLastSDKDiagnostic,
} from "@/backend/api/client";
import { tapConversationCompaction } from "@/backend/compaction-events";
import { telemetry } from "@/telemetry";
import { debugLog, debugWarn } from "@/utils/debug";
import {
  cleanupStreamAbortRelay,
  createStreamAbortRelay,
} from "@/utils/stream-abort-relay";
import { formatDuration, logTiming } from "@/utils/timing";
import { recordTuiJsonPayload, recordTuiPerf } from "@/utils/tui-perf";

import {
  type createBuffers,
  markCurrentLineAsFinished,
  markIncompleteToolsAsCancelled,
  onChunk,
  removeIncompleteTools,
  upsertStatusLine,
} from "./accumulator";
import { chunkLog } from "./chunk-log";
import type { ContextTracker } from "./context-tracker";
import {
  abortStreamController,
  summarizeChunkForDebug,
  summarizeStreamForDebug,
} from "./stream-debug";
import type {
  ApprovalRequest,
  ErrorInfo,
  StreamSequenceCursor,
} from "./stream-processor";
import {
  advanceStreamSequenceCursor,
  StreamProcessor,
} from "./stream-processor";
import {
  discoverFallbackRunIdWithTimeout,
  isReplayableRun,
  mergeApprovalRequests,
  type StreamResumePolicy,
  waitForResumeRetry,
} from "./stream-resume";
import { createStreamStallReconciler } from "./stream-stall-reconciler";
import { createTerminalEofGuard } from "./stream-terminal-eof-guard";

export { advanceStreamSequenceCursor };
export type { ApprovalRequest, StreamSequenceCursor } from "./stream-processor";

export function recordEmptyApprovalTelemetry(
  runId: string | null | undefined,
  cursor: StreamSequenceCursor | null,
): void {
  telemetry.trackError(
    "stream_requires_approval_without_approvals",
    `requires_approval stop returned no approvals (cursor=${cursor?.runId ?? "none"}:${cursor?.seqId ?? "none"})`,
    "message_stream",
    { runId: runId ?? undefined },
  );
}

export type DrainStreamHookContext = {
  chunk: LettaStreamingResponse;
  shouldOutput: boolean;
  errorInfo?: ErrorInfo;
  updatedApproval?: ApprovalRequest;
  streamProcessor: StreamProcessor;
};

export type DrainStreamHookResult = {
  shouldOutput?: boolean;
  shouldAccumulate?: boolean;
  stopReason?: StopReasonType;
};

export type DrainStreamHook = (
  ctx: DrainStreamHookContext,
) =>
  | DrainStreamHookResult
  | undefined
  | Promise<DrainStreamHookResult | undefined>;

export type DrainResult = {
  stopReason: StopReasonType;
  sawStopReasonChunk?: boolean;
  lastRunId?: string | null;
  lastSeqId?: number | null;
  approval?: ApprovalRequest | null;
  approvals?: ApprovalRequest[];
  apiDurationMs: number;
  fallbackError?: string | null;
  errorInfo?: ErrorInfo;
  terminalEofGuardFired?: boolean;
  stallReconcilerFired?: boolean;
};

export async function drainStream(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
  onFirstMessage?: () => void,
  onChunkProcessed?: DrainStreamHook,
  contextTracker?: ContextTracker,
  seenSequenceCursor?: StreamSequenceCursor | null,
  isResumeStream?: boolean,
  skipCancelToolsOnError?: boolean,
  actingUserId?: string,
): Promise<DrainResult> {
  const startTime = performance.now();
  const requestStartTime = getStreamRequestStartTime(stream) ?? startTime;
  let hasLoggedTTFT = false;

  const streamProcessor = new StreamProcessor(seenSequenceCursor ?? null);

  let stopReason: StopReasonType | null = null;
  let hasCalledFirstMessage = false;
  let fallbackError: string | null = null;
  let lastChunkDebugSummary = "none";

  let abortedViaListener = false;

  let abandonTimer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = Promise.withResolvers<{ done: true; value?: undefined }>();
  const abortHttpRead = (reason: string) => {
    abortStreamController(stream, reason);
    abandonTimer ??= setTimeout(() => abandoned.resolve({ done: true }), 5_000);
  };

  const terminalEofGuard = createTerminalEofGuard({
    getStopReason: () => streamProcessor.stopReason,
    getRunId: () => streamProcessor.lastRunId,
    abortHttpRead: () => abortStreamController(stream, "terminal_eof_guard"),
  });

  const requestContext = getStreamRequestContext(stream);
  const recoveryActingUserId = actingUserId ?? requestContext?.actingUserId;
  const stallReconciler = createStreamStallReconciler({
    getRunId: () => streamProcessor.lastRunId,
    getStopReason: () => streamProcessor.stopReason,
    canResumeWithoutRunId: () => Boolean(requestContext?.otid),
    retrieveRunStatus: async (runId, signal) =>
      (
        await getBackend().retrieveRun(runId, {
          ...(actingUserRequestOptions(recoveryActingUserId) ?? {}),
          signal,
        } as RunRetrieveOptions)
      ).status,
    abortHttpRead: () => abortHttpRead("stall_reconciler"),
  });

  const startAbortGen = buffers.abortGeneration || 0;

  const abortHandler = () => {
    abortedViaListener = true;
    abortHttpRead("abort_signal");
  };

  if (abortSignal && !abortSignal.aborted) {
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  } else if (abortSignal?.aborted) {
    abortedViaListener = true;
    abortHttpRead("pre_aborted_signal");
  }

  let iterator: AsyncIterator<LettaStreamingResponse> | undefined;
  try {
    const asyncIterator = (stream as unknown as Record<PropertyKey, unknown>)[
      Symbol.asyncIterator
    ];
    if (typeof asyncIterator !== "function") {
      throw new TypeError(
        `Stream is not async iterable (${summarizeStreamForDebug(stream)})`,
      );
    }

    stallReconciler.arm();
    iterator = terminalEofGuard.untilEof(stream)[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), abandoned.promise]);
      if (next.done) break;
      const chunk = next.value;
      stallReconciler.arm();
      lastChunkDebugSummary = summarizeChunkForDebug(chunk);
      recordTuiJsonPayload(
        `stream_chunk:${chunk.message_type ?? "unknown"}`,
        chunk,
      );

      if ((buffers.abortGeneration || 0) !== startAbortGen) {
        stopReason = "cancelled";
        queueMicrotask(refresh);
        break;
      }

      if (abortSignal?.aborted) {
        stopReason = "cancelled";
        markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
        queueMicrotask(refresh);
        break;
      }

      if (
        !hasCalledFirstMessage &&
        onFirstMessage &&
        (chunk.message_type === "reasoning_message" ||
          chunk.message_type === "assistant_message")
      ) {
        hasCalledFirstMessage = true;
        queueMicrotask(() => onFirstMessage());
      }

      if (
        !hasLoggedTTFT &&
        (chunk.message_type === "reasoning_message" ||
          chunk.message_type === "assistant_message")
      ) {
        hasLoggedTTFT = true;
        const ttft = performance.now() - requestStartTime;
        logTiming(`TTFT: ${formatDuration(ttft)} (from POST to first content)`);
      }

      const { shouldOutput, errorInfo, updatedApproval } =
        streamProcessor.processChunk(chunk);

      if (streamProcessor.stopReason !== null) {
        terminalEofGuard.arm();
      }

      try {
        chunkLog.append(chunk);
      } catch {}

      if (abortSignal?.aborted) {
        stopReason = "cancelled";
        markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
        queueMicrotask(refresh);
        break;
      }

      let shouldOutputChunk = shouldOutput;
      let shouldAccumulate = shouldOutput;

      if (onChunkProcessed) {
        const hookResult = await onChunkProcessed({
          chunk,
          shouldOutput: shouldOutputChunk,
          errorInfo,
          updatedApproval,
          streamProcessor,
        });
        if (hookResult?.shouldOutput !== undefined) {
          shouldOutputChunk = hookResult.shouldOutput;
        }
        if (hookResult?.shouldAccumulate !== undefined) {
          shouldAccumulate = hookResult.shouldAccumulate;
        } else {
          shouldAccumulate = shouldOutputChunk;
        }
        if (hookResult?.stopReason) {
          stopReason = hookResult.stopReason;
        }
      } else {
        shouldAccumulate = shouldOutputChunk;
      }

      if (shouldAccumulate) {
        recordTuiJsonPayload(
          `stream_accumulate:${chunk.message_type ?? "unknown"}`,
          chunk,
        );
        onChunk(buffers, chunk, contextTracker);
        queueMicrotask(refresh);
      }

      if (stopReason) {
        break;
      }
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const sdkDiagnostic = consumeLastSDKDiagnostic();
    const errorMessageWithDiagnostic = sdkDiagnostic
      ? `${errorMessage} [${sdkDiagnostic}]`
      : errorMessage;
    debugWarn(
      "drainStream",
      "Stream error caught: %s last_chunk=%s stream=%s",
      errorMessageWithDiagnostic,
      lastChunkDebugSummary,
      summarizeStreamForDebug(stream),
    );
    if (e instanceof Error && e.stack) {
      debugWarn("drainStream", "Stream error stack: %s", e.stack);
    }

    if (e instanceof APIError && e.error) {
      const errorObj = e.error as Record<string, unknown>;
      if (errorObj.message_type === "error_message") {
        streamProcessor.processChunk(
          errorObj as unknown as LettaStreamingResponse,
        );
      }
      if (!streamProcessor.lastRunId && typeof errorObj.run_id === "string") {
        streamProcessor.lastRunId = errorObj.run_id;
        debugWarn(
          "drainStream",
          "Extracted run_id from error:",
          streamProcessor.lastRunId,
        );
      }
    }

    fallbackError = errorMessageWithDiagnostic;

    telemetry.trackError(
      "stream_drain_error",
      errorMessageWithDiagnostic,
      "stream_drain",
      {
        runId: streamProcessor.lastRunId || undefined,
      },
    );

    stopReason = streamProcessor.stopReason || "error";
    if (skipCancelToolsOnError) {
      if (stopReason === "error") {
        buffers.interrupted = true;
      } else if (stopReason === "llm_api_error") {
        buffers.interrupted = false;
        removeIncompleteTools(buffers, "terminal_stream_error");
      }
    } else {
      markIncompleteToolsAsCancelled(buffers, true, "stream_error", true);
    }
    queueMicrotask(refresh);
  } finally {
    terminalEofGuard.clear();
    stallReconciler.clear();
    clearTimeout(abandonTimer);
    if (!terminalEofGuard.fired()) {
      void iterator?.return?.()?.catch(() => {});
    }

    try {
      chunkLog.flush();
    } catch {}

    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }

    cleanupStreamAbortRelay(stream as object);

    clearLastSDKDiagnostic();
  }

  if (!stopReason && streamProcessor.stopReason) {
    stopReason = streamProcessor.stopReason;
  }

  if (terminalEofGuard.fired()) {
    upsertStatusLine(buffers, `terminal-eof-${startTime}`, [
      "Stream did not close after completing, continued without waiting",
    ]);
  }
  if (stallReconciler.fired()) {
    upsertStatusLine(buffers, `stall-reconcile-${startTime}`, [
      "Stream went silent, reconnecting to recover the missed tail",
    ]);
  }

  if (abortedViaListener && !stopReason) {
    stopReason = "cancelled";
    markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
    queueMicrotask(refresh);
  }

  if (!stopReason) {
    stopReason = "error";
  }

  const allPending = Array.from(streamProcessor.pendingApprovals.values());
  const approvals: ApprovalRequest[] = allPending.map((a) => ({
    toolCallId: a.toolCallId,
    toolName: a.toolName || "",
    toolArgs: a.toolArgs || "",
    ...(a.messageId ? { messageId: a.messageId } : {}),
  }));
  const approval: ApprovalRequest | null = approvals[0] || null;
  streamProcessor.pendingApprovals.clear();

  if (stopReason === "end_turn" && approvals.length > 0) {
    debugWarn(
      "drainStream",
      "Coercing end_turn to requires_approval because approval_request_message chunks were received",
    );
    telemetry.trackError(
      "stream_end_turn_with_pending_approvals",
      "Stream ended with end_turn after emitting approval_request_message chunks",
      "stream_drain",
      {
        runId: streamProcessor.lastRunId || undefined,
      },
    );
    stopReason = "requires_approval";
  }

  if (stopReason === "cancelled") {
    const hadOrphanedTools = markIncompleteToolsAsCancelled(
      buffers,
      true,
      "user_interrupt",
    );
    if (hadOrphanedTools) {
      debugWarn(
        "drainStream",
        "cancelled had orphaned tool calls (see [ORPHANED_TOOL] logs for diagnosis)",
      );
    }
  } else if (stopReason === "end_turn") {
    const hadOrphanedTools = removeIncompleteTools(buffers);
    if (hadOrphanedTools) {
      debugWarn(
        "drainStream",
        "end_turn had orphaned tool calls (see [REMOVED_ORPHANED_TOOL] logs)",
      );
    }
  } else if (stopReason === "llm_api_error") {
    removeIncompleteTools(buffers, "terminal_stream_error");
  }

  if (stopReason !== "error") {
    markCurrentLineAsFinished(buffers);
  }
  queueMicrotask(refresh);

  if (
    stopReason === "requires_approval" &&
    approvals.length === 0 &&
    !isResumeStream
  ) {
    debugWarn(
      "drainStream",
      "No approvals collected despite requires_approval stop reason",
    );
  }

  const apiDurationMs = performance.now() - startTime;

  return {
    stopReason,
    sawStopReasonChunk: streamProcessor.stopReason !== null,
    approval,
    approvals,
    lastRunId: streamProcessor.lastRunId,
    lastSeqId: streamProcessor.lastSeqId,
    apiDurationMs,
    fallbackError,
    errorInfo: streamProcessor.lastErrorInfo,
    terminalEofGuardFired: terminalEofGuard.fired(),
    stallReconcilerFired: stallReconciler.fired(),
  };
}

export async function drainStreamWithResume(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
  onFirstMessage?: () => void,
  onChunkProcessed?: DrainStreamHook,
  contextTracker?: ContextTracker,
  seenSequenceCursor?: StreamSequenceCursor | null,
  resumePolicy?: StreamResumePolicy,
): Promise<DrainResult> {
  const overallStartTime = performance.now();
  recordTuiPerf("stream_lifecycle:start");
  const streamRequestContext = getStreamRequestContext(stream);
  const recoveryRequestOptions = actingUserRequestOptions(
    streamRequestContext?.actingUserId,
  );
  const streamOtid = streamRequestContext?.otid ?? null;

  let result = await drainStream(
    stream,
    buffers,
    refresh,
    abortSignal,
    onFirstMessage,
    onChunkProcessed,
    contextTracker,
    seenSequenceCursor,
    false,
    true,
  );

  let runIdToResume = result.lastRunId ?? null;
  let runIdSource: "stream_chunk" | "discovery" | "otid" | null =
    result.lastRunId ? "stream_chunk" : null;

  if (
    result.stopReason === "error" &&
    !runIdToResume &&
    streamRequestContext &&
    abortSignal &&
    !abortSignal.aborted
  ) {
    if (streamOtid) {
      runIdSource = "otid";
      debugLog(
        "stream",
        "Mid-stream resume: will use OTID-based conversations stream (otid=%s)",
        streamOtid,
      );
    } else {
      try {
        debugLog(
          "stream",
          "Mid-stream resume: attempting run discovery (conv=%s, agent=%s)",
          streamRequestContext.conversationId,
          streamRequestContext.agentId,
        );
        runIdToResume =
          await discoverFallbackRunIdWithTimeout(streamRequestContext);
        debugLog(
          "stream",
          "Mid-stream resume: run discovery result: %s",
          runIdToResume ?? "none",
        );
        if (runIdToResume) {
          result.lastRunId = runIdToResume;
          runIdSource = "discovery";
        }
      } catch (lookupError) {
        const lookupErrorMsg =
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError);
        telemetry.trackError(
          "stream_resume_lookup_failed",
          lookupErrorMsg,
          "stream_resume",
        );
        debugWarn(
          "drainStreamWithResume",
          "Fallback run_id lookup failed:",
          lookupError,
        );
      }
    }
  }

  const isApprovalPendingConflict =
    result.fallbackError?.includes("waiting for approval on a tool call") ??
    false;
  let replayGenericError = false;
  if (
    resumePolicy &&
    result.stopReason === "error" &&
    result.sawStopReasonChunk &&
    runIdToResume &&
    abortSignal &&
    !abortSignal.aborted
  ) {
    try {
      replayGenericError = isReplayableRun(
        await getBackend().retrieveRun(runIdToResume, recoveryRequestOptions),
      );
    } catch {}
  }
  const canResume =
    result.stopReason === "error" &&
    (!result.sawStopReasonChunk || replayGenericError) &&
    !isApprovalPendingConflict &&
    (runIdToResume || runIdSource === "otid") &&
    abortSignal &&
    !abortSignal.aborted;

  if (canResume) {
    const originalFallbackError = result.fallbackError;
    let originalApprovals = result.approvals;
    let originalApproval = result.approval;

    try {
      const backend = getBackend();
      const policy = resumePolicy ?? {
        initialDelayMs: 0,
        maxAttempts: 1,
        maxDelayMs: 0,
      };
      let nextSeqId = result.lastSeqId ?? 0;
      let resumeResult: DrainResult | null = null;
      let lastResumeError: unknown;

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        telemetry.trackError(
          "stream_resume_attempt",
          originalFallbackError || "Stream error (no client-side detail)",
          "stream_resume",
          { runId: result.lastRunId ?? undefined },
        );
        debugWarn(
          "stream",
          "[MID-STREAM RESUME] Attempt %d (runId=%s, lastSeqId=%s, source=%s, otid=%s)",
          attempt,
          runIdToResume ?? "none",
          nextSeqId,
          runIdSource ?? "unknown",
          streamOtid ?? "none",
        );

        buffers.commitGeneration = (buffers.commitGeneration || 0) + 1;
        buffers.interrupted = false;

        try {
          const resumeAbortRelay = createStreamAbortRelay(abortSignal);
          let resumeStream: Stream<LettaStreamingResponse>;
          try {
            resumeStream =
              runIdSource === "otid" && streamOtid && streamRequestContext
                ? await backend.streamConversationMessages(
                    streamRequestContext.resolvedConversationId,
                    {
                      agent_id:
                        streamRequestContext.conversationId === "default"
                          ? (streamRequestContext.agentId ?? undefined)
                          : undefined,
                      otid: streamOtid,
                      starting_after: nextSeqId,
                      batch_size: 1000,
                    } as unknown as ConversationMessageStreamBody,
                    {
                      ...(recoveryRequestOptions ?? {}),
                      ...(resumeAbortRelay
                        ? { signal: resumeAbortRelay.signal }
                        : {}),
                    },
                  )
                : await backend.streamRunMessages(
                    runIdToResume as string,
                    {
                      starting_after: nextSeqId,
                      batch_size: 1000,
                    } as unknown as RunMessageStreamBody,
                    {
                      ...(recoveryRequestOptions ?? {}),
                      ...(resumeAbortRelay
                        ? { signal: resumeAbortRelay.signal }
                        : {}),
                    },
                  );
          } catch (resumeError) {
            resumeAbortRelay?.cleanup();
            throw resumeError;
          }
          resumeAbortRelay?.attach(resumeStream as object);
          if (streamRequestContext) {
            tapConversationCompaction(resumeStream, {
              backend,
              conversationId: streamRequestContext.resolvedConversationId,
              agentId: streamRequestContext.agentId,
            });
          }

          const candidate = await drainStream(
            resumeStream,
            buffers,
            refresh,
            abortSignal,
            undefined,
            onChunkProcessed,
            contextTracker,
            runIdToResume ? { runId: runIdToResume, seqId: nextSeqId } : null,
            true,
            true,
            streamRequestContext?.actingUserId,
          );
          candidate.lastRunId ??= runIdToResume;
          candidate.lastSeqId ??= nextSeqId;
          runIdToResume = candidate.lastRunId ?? runIdToResume;
          result.lastRunId = runIdToResume;
          result.lastSeqId = candidate.lastSeqId;
          result.errorInfo = candidate.errorInfo ?? result.errorInfo;

          if (candidate.stopReason !== "error") {
            resumeResult = candidate;
            break;
          }

          lastResumeError = new Error(
            candidate.fallbackError || "Resumed stream ended unexpectedly",
          );
          nextSeqId = candidate.lastSeqId;
          originalApprovals = mergeApprovalRequests(
            originalApprovals,
            candidate.approvals,
          );
          originalApproval = originalApprovals[0] ?? null;

          if (candidate.sawStopReasonChunk && runIdToResume) {
            const run = await backend.retrieveRun(
              runIdToResume,
              recoveryRequestOptions,
            );
            if (!isReplayableRun(run)) break;
          }
        } catch (resumeError) {
          lastResumeError = resumeError;
          if (runIdToResume) {
            try {
              const run = await backend.retrieveRun(
                runIdToResume,
                recoveryRequestOptions,
              );
              if (!isReplayableRun(run)) break;
            } catch {}
          }
        }

        if (attempt >= policy.maxAttempts || abortSignal.aborted) break;
        const delayMs = Math.min(
          policy.initialDelayMs * 2 ** (attempt - 1),
          policy.maxDelayMs,
        );
        if (!(await waitForResumeRetry(delayMs, abortSignal))) break;
      }

      if (!resumeResult) {
        throw lastResumeError ?? new Error("Stream resume failed");
      }

      debugWarn(
        "stream",
        "[MID-STREAM RESUME] Success (runId=%s, stopReason=%s)",
        runIdToResume,
        resumeResult.stopReason,
      );
      result = resumeResult;

      if (
        result.stopReason === "requires_approval" &&
        (originalApprovals?.length ?? 0) > 0
      ) {
        if ((result.approvals?.length ?? 0) === 0) {
          result.approvals = originalApprovals;
          result.approval = originalApproval;
        } else {
          result.approvals = (result.approvals ?? []).map((resumeApproval) => {
            const orig = originalApprovals?.find(
              (a) => a.toolCallId === resumeApproval.toolCallId,
            );
            if (!orig) return resumeApproval;
            return {
              ...resumeApproval,
              toolName: resumeApproval.toolName || orig.toolName,
              toolArgs: (orig.toolArgs || "") + (resumeApproval.toolArgs || ""),
            };
          });
          result.approval = result.approvals[0] ?? null;
        }
      } else if (
        result.stopReason === "end_turn" &&
        (originalApprovals?.length ?? 0) > 0
      ) {
        debugWarn(
          "stream",
          "[MID-STREAM RESUME] Coercing resumed end_turn to requires_approval because the original stream had approval chunks",
        );
        telemetry.trackError(
          "stream_resume_end_turn_with_original_approvals",
          "Resumed stream ended with end_turn after original stream emitted approval_request_message chunks",
          "stream_resume",
          {
            runId: result.lastRunId ?? undefined,
          },
        );
        result.stopReason = "requires_approval";
        result.approvals = originalApprovals;
        result.approval = originalApproval;
      }
    } catch (resumeError) {
      markIncompleteToolsAsCancelled(buffers, false, "stream_error", true);
      markCurrentLineAsFinished(buffers);
      const resumeErrorMsg =
        resumeError instanceof Error
          ? resumeError.message
          : String(resumeError);
      result.fallbackError = originalFallbackError ?? resumeErrorMsg;
      debugWarn(
        "stream",
        "[MID-STREAM RESUME] ❌ Failed (runId=%s): %s",
        runIdToResume,
        resumeErrorMsg,
      );
      telemetry.trackError(
        "stream_resume_failed",
        resumeErrorMsg,
        "stream_resume",
        {
          runId: result.lastRunId ?? undefined,
        },
      );
    }
  }

  if (result.stopReason === "error") {
    const skipReasons: string[] = [];
    if (result.sawStopReasonChunk && !replayGenericError)
      skipReasons.push("terminal_stop_reason");
    if (!result.lastRunId && runIdSource !== "otid")
      skipReasons.push("no_run_id");
    if (!abortSignal) skipReasons.push("no_abort_signal");
    if (abortSignal?.aborted) skipReasons.push("user_aborted");

    if (skipReasons.length > 0) {
      markIncompleteToolsAsCancelled(buffers, false, "stream_error", true);
      markCurrentLineAsFinished(buffers);
      debugLog(
        "stream",
        "Mid-stream resume skipped: %s",
        skipReasons.join(", "),
      );
      telemetry.trackError(
        "stream_resume_skipped",
        `${result.fallbackError || "Stream error (no client-side detail)"} [skip: ${skipReasons.join(", ")}]`,
        "stream_resume",
        {
          runId: result.lastRunId ?? undefined,
        },
      );
    }
  }

  if (
    result.stopReason === "requires_approval" &&
    (result.approvals?.length ?? 0) > 0 &&
    buffers.interrupted
  ) {
    buffers.interrupted = false;
    markCurrentLineAsFinished(buffers);
  }

  result.apiDurationMs = performance.now() - overallStartTime;
  recordTuiPerf(`stream_lifecycle:end:${result.stopReason}`, {
    ms: result.apiDurationMs,
  });

  return result;
}
