import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { getClient } from "../../agent/client";
import { STREAM_REQUEST_START_TIME } from "../../agent/message";
import { debugWarn } from "../../utils/debug";
import { formatDuration, logTiming } from "../../utils/timing";

import {
  type createBuffers,
  markCurrentLineAsFinished,
  markIncompleteToolsAsCancelled,
  onChunk,
} from "./accumulator";
import type { ContextTracker } from "./contextTracker";
import type { ErrorInfo } from "./streamProcessor";
import { StreamProcessor } from "./streamProcessor";

export type ApprovalRequest = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

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

type DrainResult = {
  stopReason: StopReasonType;
  lastRunId?: string | null;
  lastSeqId?: number | null;
  approval?: ApprovalRequest | null; // DEPRECATED: kept for backward compat
  approvals?: ApprovalRequest[]; // NEW: supports parallel approvals
  apiDurationMs: number; // time spent in API call
  fallbackError?: string | null; // Error message for when we can't fetch details from server (no run_id)
};

export async function drainStream(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
  onFirstMessage?: () => void,
  onChunkProcessed?: DrainStreamHook,
  contextTracker?: ContextTracker,
): Promise<DrainResult> {
  const startTime = performance.now();

  // Extract request start time for TTFT logging (attached by sendMessageStream)
  const requestStartTime = (
    stream as unknown as Record<symbol, number | undefined>
  )[STREAM_REQUEST_START_TIME];
  let hasLoggedTTFT = false;

  const streamProcessor = new StreamProcessor();

  let stopReason: StopReasonType | null = null;
  let hasCalledFirstMessage = false;
  let fallbackError: string | null = null;

  // Track if we triggered abort via our listener (for eager cancellation)
  let abortedViaListener = false;

  // Capture the abort generation at stream start to detect if handleInterrupt ran
  const startAbortGen = buffers.abortGeneration || 0;

  // Set up abort listener to propagate our signal to SDK's stream controller
  // This immediately cancels the HTTP request instead of waiting for next chunk
  const abortHandler = () => {
    abortedViaListener = true;
    // Abort the SDK's stream controller to cancel the underlying HTTP request
    if (!stream.controller) {
      debugWarn(
        "drainStream",
        "stream.controller is undefined - cannot abort HTTP request",
      );
      return;
    }
    if (!stream.controller.signal.aborted) {
      stream.controller.abort();
    }
  };

  if (abortSignal && !abortSignal.aborted) {
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  } else if (abortSignal?.aborted) {
    // Already aborted before we started
    abortedViaListener = true;
    if (stream.controller && !stream.controller.signal.aborted) {
      stream.controller.abort();
    }
  }

  try {
    for await (const chunk of stream) {
      // console.log("chunk", chunk);

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
        requestStartTime !== undefined &&
        (chunk.message_type === "reasoning_message" ||
          chunk.message_type === "assistant_message")
      ) {
        hasLoggedTTFT = true;
        const ttft = performance.now() - requestStartTime;
        logTiming(`TTFT: ${formatDuration(ttft)} (from POST to first content)`);
      }

      const { shouldOutput, errorInfo, updatedApproval } =
        streamProcessor.processChunk(chunk);

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
    debugWarn("drainStream", "Stream error caught:", errorMessage);

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

    // Only set fallbackError if we don't have a run_id - if we have a run_id,
    // App.tsx will fetch detailed error info from the server which is better
    if (!streamProcessor.lastRunId) {
      fallbackError = errorMessage;
    }

    // Preserve a stop reason already parsed from stream chunks (e.g. llm_api_error)
    // and only fall back to generic "error" when none is available.
    stopReason = streamProcessor.stopReason || "error";
    markIncompleteToolsAsCancelled(buffers, true, "stream_error");
    queueMicrotask(refresh);
  } finally {
    // Clean up abort listener
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }

  if (!stopReason && streamProcessor.stopReason) {
    stopReason = streamProcessor.stopReason;
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

  // Mark incomplete tool calls as cancelled if stream was cancelled
  if (stopReason === "cancelled") {
    markIncompleteToolsAsCancelled(buffers, true, "user_interrupt");
  }

  // Mark the final line as finished now that stream has ended
  markCurrentLineAsFinished(buffers);
  queueMicrotask(refresh);

  // Package the approval request(s) at the end, with validation
  let approval: ApprovalRequest | null = null;
  let approvals: ApprovalRequest[] = [];

  if (stopReason === "requires_approval") {
    // Convert map to array, including ALL tool_call_ids (even incomplete ones)
    // Incomplete entries will be denied at the business logic layer
    const allPending = Array.from(streamProcessor.pendingApprovals.values());
    // console.log(
    // "[drainStream] All pending approvals before processing:",
    // JSON.stringify(allPending, null, 2),
    // );

    // Include ALL tool_call_ids - don't filter out incomplete entries
    // Missing name/args will be handled by denial logic in App.tsx
    // Default empty toolArgs to "{}" - empty string causes JSON.parse("") to fail
    // This happens for tools with no parameters (e.g., EnterPlanMode, ExitPlanMode)
    approvals = allPending.map((a) => ({
      toolCallId: a.toolCallId,
      toolName: a.toolName || "",
      toolArgs: a.toolArgs || "{}",
    }));

    if (approvals.length === 0) {
      debugWarn(
        "drainStream",
        "No approvals collected despite requires_approval stop reason",
      );
      debugWarn("drainStream", "Pending approvals map:", allPending);
    } else {
      // Set legacy singular field for backward compatibility
      approval = approvals[0] || null;
    }

    // Clear the map for next turn
    streamProcessor.pendingApprovals.clear();
  }

  const apiDurationMs = performance.now() - startTime;

  return {
    stopReason,
    approval,
    approvals,
    lastRunId: streamProcessor.lastRunId,
    lastSeqId: streamProcessor.lastSeqId,
    apiDurationMs,
    fallbackError,
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
): Promise<DrainResult> {
  const overallStartTime = performance.now();

  // Attempt initial drain
  let result = await drainStream(
    stream,
    buffers,
    refresh,
    abortSignal,
    onFirstMessage,
    onChunkProcessed,
    contextTracker,
  );

  // If stream ended without proper stop_reason and we have resume info, try once to reconnect
  // Only resume if we have an abortSignal AND it's not aborted (explicit check prevents
  // undefined abortSignal from accidentally allowing resume after user cancellation)
  if (
    result.stopReason === "error" &&
    result.lastRunId &&
    result.lastSeqId !== null &&
    abortSignal &&
    !abortSignal.aborted
  ) {
    // Preserve the original error in case resume fails
    const originalFallbackError = result.fallbackError;

    try {
      const client = await getClient();

      // Reset interrupted flag so resumed chunks can be processed by onChunk.
      // Without this, tool_return_message for server-side tools (web_search, fetch_webpage)
      // would be silently ignored, showing "Interrupted by user" even on successful resume.
      // Increment commitGeneration to invalidate any pending setTimeout refreshes that would
      // commit the stale "Interrupted by user" state before the resume stream completes.
      buffers.commitGeneration = (buffers.commitGeneration || 0) + 1;
      buffers.interrupted = false;

      // Resume from Redis where we left off
      // TODO: Re-enable once issues are resolved - disabled retries were causing problems
      // Disable SDK retries - state management happens outside, retries would create race conditions
      const resumeStream = await client.runs.messages.stream(
        result.lastRunId,
        {
          starting_after: result.lastSeqId,
          batch_size: 1000, // Fetch buffered chunks quickly
        },
        // { maxRetries: 0 },
      );

      // Continue draining from where we left off
      // Note: Don't pass onFirstMessage again - already called in initial drain
      const resumeResult = await drainStream(
        resumeStream,
        buffers,
        refresh,
        abortSignal,
        undefined,
        onChunkProcessed,
        contextTracker,
      );

      // Use the resume result (should have proper stop_reason now)
      // Clear the original stream error since we recovered
      result = resumeResult;
    } catch (_e) {
      // Resume failed - stick with the error stop_reason
      // Restore the original stream error for display
      result.fallbackError = originalFallbackError;
    }
  }

  // Update duration to reflect total time (including resume attempt)
  result.apiDurationMs = performance.now() - overallStartTime;

  return result;
}
