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

export type ApprovalRequest = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

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
): Promise<DrainResult> {
  const startTime = performance.now();

  // Extract request start time for TTFT logging (attached by sendMessageStream)
  const requestStartTime = (
    stream as unknown as Record<symbol, number | undefined>
  )[STREAM_REQUEST_START_TIME];
  let hasLoggedTTFT = false;

  let _approvalRequestId: string | null = null;
  const pendingApprovals = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      toolArgs: string;
    }
  >();

  let stopReason: StopReasonType | null = null;
  let lastRunId: string | null = null;
  let lastSeqId: number | null = null;
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
        markIncompleteToolsAsCancelled(buffers);
        queueMicrotask(refresh);
        break;
      }
      // Store the run_id (for error reporting) and seq_id (for stream resumption)
      // Capture run_id even if seq_id is missing - we need it for error details
      if ("run_id" in chunk && chunk.run_id) {
        lastRunId = chunk.run_id;
      }
      if ("seq_id" in chunk && chunk.seq_id) {
        lastSeqId = chunk.seq_id;
      }

      if (chunk.message_type === "ping") continue;

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

      // Remove tool from pending approvals when it completes (server-side execution finished)
      // This means the tool was executed server-side and doesn't need approval
      if (chunk.message_type === "tool_return_message") {
        if (chunk.tool_call_id) {
          pendingApprovals.delete(chunk.tool_call_id);
        }
        // Continue processing this chunk (for UI display)
      }

      // Need to store the approval request ID to send an approval in a new run
      if (chunk.message_type === "approval_request_message") {
        _approvalRequestId = chunk.id;
      }

      // Accumulate approval request state across streaming chunks
      // Support parallel tool calls by tracking each tool_call_id separately
      // NOTE: Only track approval_request_message, NOT tool_call_message
      // tool_call_message = auto-executed server-side (e.g., web_search)
      // approval_request_message = needs user approval (e.g., Bash)
      if (chunk.message_type === "approval_request_message") {
        // console.log(
        // "[drainStream] approval_request_message chunk:",
        // JSON.stringify(chunk, null, 2),
        // );

        // Normalize tool calls: support both legacy tool_call and new tool_calls array
        const toolCalls = Array.isArray(chunk.tool_calls)
          ? chunk.tool_calls
          : chunk.tool_call
            ? [chunk.tool_call]
            : [];

        for (const toolCall of toolCalls) {
          if (!toolCall?.tool_call_id) continue; // strict: require id

          // Get or create entry for this tool_call_id
          const existing = pendingApprovals.get(toolCall.tool_call_id) || {
            toolCallId: toolCall.tool_call_id,
            toolName: "",
            toolArgs: "",
          };

          // Update name if provided
          if (toolCall.name) {
            existing.toolName = toolCall.name;
          }

          // Accumulate arguments (may arrive across multiple chunks)
          if (toolCall.arguments) {
            existing.toolArgs += toolCall.arguments;
          }

          pendingApprovals.set(toolCall.tool_call_id, existing);
        }
      }

      // Check abort signal before processing - don't add data after interrupt
      if (abortSignal?.aborted) {
        stopReason = "cancelled";
        markIncompleteToolsAsCancelled(buffers);
        queueMicrotask(refresh);
        break;
      }

      // Suppress mid-stream desync errors (match headless behavior)
      // These are transient and will be handled by end-of-turn desync recovery
      const errObj = (chunk as unknown as { error?: { detail?: string } })
        .error;
      if (
        errObj?.detail?.includes("No tool call is currently awaiting approval")
      ) {
        // Server isn't ready for approval yet; let the stream continue
        // Suppress the error frame from output
        continue;
      }

      onChunk(buffers, chunk);
      queueMicrotask(refresh);

      if (chunk.message_type === "stop_reason") {
        stopReason = chunk.stop_reason;
        // Continue reading stream to get usage_statistics that may come after
      }
    }
  } catch (e) {
    // Handle stream errors (e.g., JSON parse errors from SDK, network issues)
    // This can happen when the stream ends with incomplete data
    const errorMessage = e instanceof Error ? e.message : String(e);
    debugWarn("drainStream", "Stream error caught:", errorMessage);

    // Try to extract run_id from APIError if we don't have one yet
    if (!lastRunId && e instanceof APIError && e.error) {
      const errorObj = e.error as Record<string, unknown>;
      if ("run_id" in errorObj && typeof errorObj.run_id === "string") {
        lastRunId = errorObj.run_id;
        debugWarn("drainStream", "Extracted run_id from error:", lastRunId);
      }
    }

    // Only set fallbackError if we don't have a run_id - if we have a run_id,
    // App.tsx will fetch detailed error info from the server which is better
    if (!lastRunId) {
      fallbackError = errorMessage;
    }

    // Set error stop reason so drainStreamWithResume can try to reconnect
    stopReason = "error";
    markIncompleteToolsAsCancelled(buffers);
    queueMicrotask(refresh);
  } finally {
    // Clean up abort listener
    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }

  // If we aborted via listener but loop exited without setting stopReason
  // (SDK returns gracefully on abort), mark as cancelled
  if (abortedViaListener && !stopReason) {
    stopReason = "cancelled";
    markIncompleteToolsAsCancelled(buffers);
    queueMicrotask(refresh);
  }

  // Stream has ended, check if we captured a stop reason
  if (!stopReason) {
    stopReason = "error";
  }

  // Mark incomplete tool calls as cancelled if stream was cancelled
  if (stopReason === "cancelled") {
    markIncompleteToolsAsCancelled(buffers);
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
    const allPending = Array.from(pendingApprovals.values());
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
    pendingApprovals.clear();
    _approvalRequestId = null;
  }

  const apiDurationMs = performance.now() - startTime;

  return {
    stopReason,
    approval,
    approvals,
    lastRunId,
    lastSeqId,
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
 * @returns Result with stop_reason, approval info, and timing
 */
export async function drainStreamWithResume(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
  onFirstMessage?: () => void,
): Promise<DrainResult> {
  const overallStartTime = performance.now();

  // Attempt initial drain
  let result = await drainStream(
    stream,
    buffers,
    refresh,
    abortSignal,
    onFirstMessage,
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
