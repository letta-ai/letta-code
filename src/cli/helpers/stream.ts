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
import type { ApprovalRequest, ErrorInfo } from "./stream-processor";
import { StreamProcessor } from "./stream-processor";
import {
  discoverFallbackRunIdWithTimeout,
  isReplayableRun,
  mergeApprovalRequests,
  type StreamResumePolicy,
  waitForResumeRetry,
} from "./stream-resume";
import { createStreamStallReconciler } from "./stream-stall-reconciler";
import { createTerminalEofGuard } from "./stream-terminal-eof-guard";

export type { ApprovalRequest } from "./stream-processor";

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
  approval?: ApprovalRequest | null; // DEPRECATED: kept for backward compat
  approvals?: ApprovalRequest[]; // NEW: supports parallel approvals
  apiDurationMs: number; // time spent in API call
  fallbackError?: string | null; // Error message for when we can't fetch details from server (no run_id)
  terminalEofGuardFired?: boolean; // HTTP body never ended after the terminal SSE sequence; guard aborted the read
  stallReconcilerFired?: boolean; // Stream went silent mid-run; reconciler aborted the dead read to reconnect
};

export async function drainStream(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
  onFirstMessage?: () => void,
  onChunkProcessed?: DrainStreamHook,
  contextTracker?: ContextTracker,
  seenSeqIdThreshold?: number | null,
  isResumeStream?: boolean,
  skipCancelToolsOnError?: boolean,
  actingUserId?: string,
): Promise<DrainResult> {
  const startTime = performance.now();
  const requestStartTime = getStreamRequestStartTime(stream) ?? startTime;
  let hasLoggedTTFT = false;

  const streamProcessor = new StreamProcessor(seenSeqIdThreshold ?? null);

  let stopReason: StopReasonType | null = null;
  let hasCalledFirstMessage = false;
  let fallbackError: string | null = null;
  let lastChunkDebugSummary = "none";

  // Track if we triggered abort via our listener (for eager cancellation)
  let abortedViaListener = false;

  // Terminal-EOF guard: once the terminal SSE sequence has arrived, don't wait
  // forever for HTTP body EOF (see stream-terminal-eof-guard.ts).
  const terminalEofGuard = createTerminalEofGuard({
    getStopReason: () => streamProcessor.stopReason,
    getRunId: () => streamProcessor.lastRunId,
    abortHttpRead: () => abortStreamController(stream, "terminal_eof_guard"),
  });

  // Stall reconciler: if the stream goes silent mid-run (server pings every
  // ~20s, so silence means a dead read, not a slow model), then abort the dead
  // read so the resume path can replay the lost tail. A server-side status
  // check avoids reconnecting an active run when it is available.
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
    abortHttpRead: () => abortStreamController(stream, "stall_reconciler"),
  });

  // Capture the abort generation at stream start to detect if handleInterrupt ran
  const startAbortGen = buffers.abortGeneration || 0;

  // Set up abort listener to propagate our signal to SDK's stream controller
  // This immediately cancels the HTTP request instead of waiting for next chunk
  const abortHandler = () => {
    abortedViaListener = true;
    abortStreamController(stream, "abort_signal");
  };

  if (abortSignal && !abortSignal.aborted) {
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  } else if (abortSignal?.aborted) {
    // Already aborted before we started
    abortedViaListener = true;
    abortStreamController(stream, "pre_aborted_signal");
  }

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
    for await (const chunk of stream) {
      stallReconciler.arm();
      lastChunkDebugSummary = summarizeChunkForDebug(chunk);
      recordTuiJsonPayload(
        `stream_chunk:${chunk.message_type ?? "unknown"}`,
        chunk,
      );

      // Check if abort generation changed (handleInterrupt ran while we were waiting)
      // This catches cases where the abort signal might not propagate correctly
      if ((buffers.abortGeneration || 0) !== startAbortGen) {
        stopReason = "cancelled";
        // Don't call markIncompleteToolsAsCancelled - handleInterrupt already did
        queueMicrotask(refresh);
        break;
      }

      // Check if stream was aborted
      if (abortSignal?.aborted) {
        stopReason = "cancelled";
        markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
        queueMicrotask(refresh);
        break;
      }

      // Call onFirstMessage callback on the first agent response chunk
      if (
        !hasCalledFirstMessage &&
        onFirstMessage &&
        (chunk.message_type === "reasoning_message" ||
          chunk.message_type === "assistant_message")
      ) {
        hasCalledFirstMessage = true;
        // Call async in background - don't block stream processing
        queueMicrotask(() => onFirstMessage());
      }

      // Log TTFT (time-to-first-token) when first content chunk arrives
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

      // Once the terminal sequence starts (stop_reason received), (re-)arm the
      // EOF guard on every subsequent chunk. Only usage_statistics and [DONE]
      // legitimately follow stop_reason, so this fires only when the HTTP body
      // stays open with no data after the terminal sequence.
      if (streamProcessor.stopReason !== null) {
        terminalEofGuard.arm();
      }

      // Log chunk for feedback diagnostics
      try {
        chunkLog.append(chunk);
      } catch {
        // Silently ignore -- diagnostics should not break streaming
      }

      // Check abort signal before processing - don't add data after interrupt
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
    // Handle stream errors (e.g., JSON parse errors from SDK, network issues)
    // This can happen when the stream ends with incomplete data
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

    // Try to extract run_id from APIError if we don't have one yet
    if (!streamProcessor.lastRunId && e instanceof APIError && e.error) {
      const errorObj = e.error as Record<string, unknown>;
      if ("run_id" in errorObj && typeof errorObj.run_id === "string") {
        streamProcessor.lastRunId = errorObj.run_id;
        debugWarn(
          "drainStream",
          "Extracted run_id from error:",
          streamProcessor.lastRunId,
        );
      }
    }

    // Always capture the client-side error message. Even when we have a run_id
    // (and App.tsx can fetch server-side detail), the client-side exception is
    // valuable for telemetry — e.g. stream disconnections where the server run
    // is still in-progress and has no error metadata yet.
    fallbackError = errorMessageWithDiagnostic;

    telemetry.trackError(
      "stream_drain_error",
      errorMessageWithDiagnostic,
      "stream_drain",
      {
        runId: streamProcessor.lastRunId || undefined,
      },
    );

    // Preserve a stop reason already parsed from stream chunks (e.g. llm_api_error)
    // and only fall back to generic "error" when none is available.
    stopReason = streamProcessor.stopReason || "error";
    // skipMarkCurrentLine=true: if a resume follows, the resume stream will
    // finalize the streaming line with full text. Marking it finished now would
    // commit truncated content to static (emittedIdsRef) before resume can append.
    // drainStreamWithResume calls markCurrentLineAsFinished if no resume happens.
    //
    // skipCancelToolsOnError: when drainStreamWithResume may attempt a resume,
    // don't cancel tool calls for resumable stream drops yet — the resume stream
    // replays tool_return_message chunks that overwrite any cancelled state.
    // If the server already emitted a terminal provider error, though, the run
    // is not resumable; any incomplete tools from that failed run are artifacts
    // and should not survive into the next retry run.
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

    // Persist chunk log to disk (one write per stream, not per chunk)
    try {
      chunkLog.flush();
    } catch {
      // Silently ignore -- diagnostics should not break streaming
    }

    // Clean up abort listener
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }

    cleanupStreamAbortRelay(stream as object);

    // Clear SDK parse diagnostics on stream completion so they don't leak
    // into a future stream. On error paths the catch block already consumed
    // them; this handles the success path.
    clearLastSDKDiagnostic();
  }

  if (!stopReason && streamProcessor.stopReason) {
    stopReason = streamProcessor.stopReason;
  }

  // Surface guard firings: the user already sat through the grace period of
  // dead air, so continuing silently would read as unexplained slowness.
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

  // If we aborted via listener but loop exited without setting stopReason
  // (SDK returns gracefully on abort), mark as cancelled
  if (abortedViaListener && !stopReason) {
    stopReason = "cancelled";
    markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
    queueMicrotask(refresh);
  }

  // Stream has ended, check if we captured a stop reason
  if (!stopReason) {
    stopReason = "error";
  }

  // Package the approval request(s) before cleanup.
  // Always extract from streamProcessor regardless of stopReason so that
  // drainStreamWithResume can carry them across a resume boundary (the
  // resumed stream uses a fresh streamProcessor that won't have them).
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

  // Clean up incomplete tool calls:
  // - cancelled: user interrupted, show "Interrupted by user"
  // - end_turn: server ended without completing, remove entirely (don't show anything)
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

  // Mark the final line as finished now that stream has ended.
  // Skip for error stop reason — drainStreamWithResume will finalize after
  // resume succeeds (or in its catch/else path if no resume is attempted).
  if (stopReason !== "error") {
    markCurrentLineAsFinished(buffers);
  }
  queueMicrotask(refresh);

  if (
    stopReason === "requires_approval" &&
    approvals.length === 0 &&
    !isResumeStream
  ) {
    // On resume streams, approval chunks are before starting_after and won't be replayed.
    // drainStreamWithResume carries them over from the original drain — this is expected.
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
    terminalEofGuardFired: terminalEofGuard.fired(),
    stallReconcilerFired: stallReconciler.fired(),
  };
}

/**
 * Drain a stream with automatic resume on disconnect.
 *
 * If the stream ends without receiving a proper stop_reason chunk (indicating
 * an unexpected disconnect), this will automatically attempt to resume from
 * Redis using the last received run_id and seq_id.
 *
 * @param stream - Initial stream from agent.messages.stream()
 * @param buffers - Buffer to accumulate chunks
 * @param refresh - Callback to refresh UI
 * @param abortSignal - Optional abort signal for cancellation
 * @param onFirstMessage - Optional callback to invoke on first message chunk
 * @param onChunkProcessed - Optional hook to observe/override per-chunk behavior
 * @returns Result with stop_reason, approval info, and timing
 */
export async function drainStreamWithResume(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
  onFirstMessage?: () => void,
  onChunkProcessed?: DrainStreamHook,
  contextTracker?: ContextTracker,
  seenSeqIdThreshold?: number | null,
  resumePolicy?: StreamResumePolicy,
): Promise<DrainResult> {
  const overallStartTime = performance.now();
  recordTuiPerf("stream_lifecycle:start");
  const streamRequestContext = getStreamRequestContext(stream);
  const recoveryRequestOptions = actingUserRequestOptions(
    streamRequestContext?.actingUserId,
  );
  // Use the message OTID stored in the request context (set from messages[0].otid).
  // This is the real UUID OTID — distinct from the tool execution context ID
  // returned by getStreamToolContextId (which is ctx-{ts}-N, not meaningful for resume).
  const streamOtid = streamRequestContext?.otid ?? null;

  // Attempt initial drain.
  // skipCancelToolsOnError=true: don't cancel tool calls on stream error here —
  // drainStreamWithResume will attempt a resume that replays tool_return_message
  // chunks. Tools are only cancelled in the failure/no-resume paths below.
  let result = await drainStream(
    stream,
    buffers,
    refresh,
    abortSignal,
    onFirstMessage,
    onChunkProcessed,
    contextTracker,
    seenSeqIdThreshold,
    false, // isResumeStream
    true, // skipCancelToolsOnError
  );

  let runIdToResume = result.lastRunId ?? null;
  let runIdSource: "stream_chunk" | "discovery" | "otid" | null =
    result.lastRunId ? "stream_chunk" : null;

  // If the stream failed before exposing run_id, attempt to find the right run.
  // Prefer OTID-based lookup via the conversations stream endpoint: it lets the
  // server resolve exactly which run corresponds to this client's message, which
  // is safe in multi-client scenarios (timestamp heuristic is not).
  // Fall back to timestamp-based discovery if OTID is unavailable.
  if (
    result.stopReason === "error" &&
    !runIdToResume &&
    streamRequestContext &&
    abortSignal &&
    !abortSignal.aborted
  ) {
    if (streamOtid) {
      // OTID path: server resolves the run — no client-side discovery needed.
      runIdSource = "otid";
      debugLog(
        "stream",
        "Mid-stream resume: will use OTID-based conversations stream (otid=%s)",
        streamOtid,
      );
    } else {
      // Fallback: timestamp-based run discovery.
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

  // If stream ended without proper stop_reason and we have resume info, try once to reconnect.
  // Only resume if we have an abortSignal AND it's not aborted (explicit check prevents
  // undefined abortSignal from accidentally allowing resume after user cancellation).
  // Approval-pending conflicts are not resumable disconnects — let App's approval
  // recovery path handle them instead.
  // "waiting for approval on a tool call" = server in requires_approval state, not resumable
  // (distinct from "is currently being processed" = conversation-busy 409, which IS resumable)
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
    } catch {
      // If status cannot be checked, keep the streamed stop reason authoritative.
    }
  }
  const canResume =
    result.stopReason === "error" &&
    (!result.sawStopReasonChunk || replayGenericError) &&
    !isApprovalPendingConflict &&
    (runIdToResume || runIdSource === "otid") &&
    abortSignal &&
    !abortSignal.aborted;

  if (canResume) {
    // Resume path: markCurrentLineAsFinished was skipped in the catch block.
    // If resume fails below, we call it in the catch. If no resume condition is
    // met (else branch), we call it there instead.
    // Preserve original state in case resume needs to merge or fails
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

        // Reset interrupted state before each replay so resumed chunks can be
        // accumulated. The final failure path below cancels incomplete tools.
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

          const candidate = await drainStream(
            resumeStream,
            buffers,
            refresh,
            abortSignal,
            undefined,
            onChunkProcessed,
            contextTracker,
            seenSeqIdThreshold,
            true,
            true,
            streamRequestContext?.actingUserId,
          );
          candidate.lastRunId ??= runIdToResume;
          candidate.lastSeqId ??= nextSeqId;
          runIdToResume = candidate.lastRunId ?? runIdToResume;
          result.lastRunId = runIdToResume;
          result.lastSeqId = candidate.lastSeqId;

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
            } catch {
              // A failed status check should not hide a recoverable stream drop.
            }
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

      // The resumed stream uses a fresh streamProcessor that won't have
      // approval_request_message chunks from before the disconnect (they
      // had seq_id <= lastSeqId).
      //
      // Two cases:
      // 1. All approval chunks were before the drop (resume has no approvals):
      //    carry over the originals unchanged.
      // 2. Approval args were split across the drop (original has prefix,
      //    resume has suffix): merge them so the full args string is intact.
      if (
        result.stopReason === "requires_approval" &&
        (originalApprovals?.length ?? 0) > 0
      ) {
        if ((result.approvals?.length ?? 0) === 0) {
          // Case 1: full carry-over
          result.approvals = originalApprovals;
          result.approval = originalApproval;
        } else {
          // Case 2: merge prefix args from original with suffix args from resume
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
      // Resume failed - cancel tools and finalize the streaming line now
      // (both were skipped in the initial drain's catch block above)
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

  // Log when stream errored but resume was NOT attempted, with reasons why
  if (result.stopReason === "error") {
    const skipReasons: string[] = [];
    if (result.sawStopReasonChunk && !replayGenericError)
      skipReasons.push("terminal_stop_reason");
    if (!result.lastRunId && runIdSource !== "otid")
      skipReasons.push("no_run_id");
    if (!abortSignal) skipReasons.push("no_abort_signal");
    if (abortSignal?.aborted) skipReasons.push("user_aborted");

    // Only log if we actually skipped for a reason (i.e., we didn't enter the resume branch above)
    if (skipReasons.length > 0) {
      // No resume — cancel tools and finalize the streaming line now
      // (both were skipped in the initial drain's catch block above)
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

  // If the initial drain's catch block set buffers.interrupted=true (skipCancelToolsOnError)
  // but the stream ended with complete requires_approval data (stop_reason chunk arrived
  // before the drop), no resume is needed — clean up so the approval prompt renders correctly.
  if (
    result.stopReason === "requires_approval" &&
    (result.approvals?.length ?? 0) > 0 &&
    buffers.interrupted
  ) {
    buffers.interrupted = false;
    markCurrentLineAsFinished(buffers);
  }

  // Update duration to reflect total time (including resume attempt)
  result.apiDurationMs = performance.now() - overallStartTime;
  recordTuiPerf(`stream_lifecycle:end:${result.stopReason}`, {
    ms: result.apiDurationMs,
  });

  return result;
}
