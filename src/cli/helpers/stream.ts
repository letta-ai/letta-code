import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type {
  LettaStreamingResponse,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import {
  clearLastSDKDiagnostic,
  consumeLastSDKDiagnostic,
  getClient,
} from "../../agent/client";
import {
  getStreamRequestContext,
  getStreamRequestStartTime,
} from "../../agent/message";
import { telemetry } from "../../telemetry";
import { debugWarn } from "../../utils/debug";
import { formatDuration, logTiming } from "../../utils/timing";

import {
  type createBuffers,
  markCurrentLineAsFinished,
  markIncompleteToolsAsCancelled,
  onChunk,
} from "./accumulator";
import { chunkLog } from "./chunkLog";
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

type StreamRequestContext = NonNullable<
  ReturnType<typeof getStreamRequestContext>
>;

type RunsListResponse =
  | Run[]
  | {
      getPaginatedItems?: () => Run[];
    };

type RunsListClient = {
  runs: {
    list: (query: {
      conversation_id?: string | null;
      agent_id?: string | null;
      statuses?: string[] | null;
      order?: string | null;
      limit?: number | null;
    }) => Promise<RunsListResponse>;
  };
};

const FALLBACK_RUN_DISCOVERY_TIMEOUT_MS = 5000;

function parseRunCreatedAtMs(run: Run): number {
  if (!run.created_at) return 0;
  const parsed = Date.parse(run.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function discoverFallbackRunIdWithTimeout(
  client: RunsListClient,
  ctx: StreamRequestContext,
): Promise<string | null> {
  return withTimeout(
    discoverFallbackRunIdForResume(client, ctx),
    FALLBACK_RUN_DISCOVERY_TIMEOUT_MS,
    `Fallback run discovery timed out after ${FALLBACK_RUN_DISCOVERY_TIMEOUT_MS}ms`,
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toRunsArray(listResponse: RunsListResponse): Run[] {
  if (Array.isArray(listResponse)) return listResponse;
  if (
    listResponse &&
    typeof listResponse === "object" &&
    "getPaginatedItems" in listResponse &&
    typeof (listResponse as { getPaginatedItems?: unknown })
      .getPaginatedItems === "function"
  ) {
    return (
      (
        listResponse as { getPaginatedItems: () => Run[] }
      ).getPaginatedItems() ?? []
    );
  }
  return [];
}

/**
 * Attempt to discover a run ID to resume when the initial stream failed before
 * any run_id-bearing chunk arrived.
 */
export async function discoverFallbackRunIdForResume(
  client: RunsListClient,
  ctx: StreamRequestContext,
): Promise<string | null> {
  const statuses = ["running"];
  const requestStartedAtMs = ctx.requestStartedAtMs;

  const listCandidates = async (query: {
    conversation_id?: string | null;
    agent_id?: string | null;
  }): Promise<Run[]> => {
    const response = (await client.runs.list({
      ...query,
      statuses,
      order: "desc",
      limit: 1,
    })) as RunsListResponse;
    return toRunsArray(response).filter((run) => {
      if (!run.id) return false;
      if (run.status !== "running") return false;
      // Best-effort temporal filter: only consider runs created after
      // this send request started. In rare concurrent-send races within
      // the same conversation, this heuristic can still pick a neighbor run.
      return parseRunCreatedAtMs(run) >= requestStartedAtMs;
    });
  };

  const lookupQueries: Array<{
    conversation_id?: string | null;
    agent_id?: string | null;
  }> = [];

  if (ctx.conversationId === "default") {
    // Default conversation routes through resolvedConversationId (typically agent ID).
    lookupQueries.push({ conversation_id: ctx.resolvedConversationId });
  } else {
    // Named conversation: first use the explicit conversation id.
    lookupQueries.push({ conversation_id: ctx.conversationId });

    // Keep resolved route as backup only when it differs.
    if (ctx.resolvedConversationId !== ctx.conversationId) {
      lookupQueries.push({ conversation_id: ctx.resolvedConversationId });
    }
  }

  if (ctx.agentId) {
    lookupQueries.push({ agent_id: ctx.agentId });
  }

  for (const query of lookupQueries) {
    const candidates = await listCandidates(query);
    if (candidates[0]?.id) return candidates[0].id;
  }

  return null;
}

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
  const requestStartTime = getStreamRequestStartTime(stream) ?? startTime;
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
        (chunk.message_type === "reasoning_message" ||
          chunk.message_type === "assistant_message")
      ) {
        hasLoggedTTFT = true;
        const ttft = performance.now() - requestStartTime;
        logTiming(`TTFT: ${formatDuration(ttft)} (from POST to first content)`);
      }

      const { shouldOutput, errorInfo, updatedApproval } =
        streamProcessor.processChunk(chunk);

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

    // Always capture the client-side error message. Even when we have a run_id
    // (and App.tsx can fetch server-side detail), the client-side exception is
    // valuable for telemetry — e.g. stream disconnections where the server run
    // is still in-progress and has no error metadata yet.
    fallbackError = errorMessageWithDiagnostic;

    // Preserve a stop reason already parsed from stream chunks (e.g. llm_api_error)
    // and only fall back to generic "error" when none is available.
    stopReason = streamProcessor.stopReason || "error";
    markIncompleteToolsAsCancelled(buffers, true, "stream_error");
    queueMicrotask(refresh);
  } finally {
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

    // Clear SDK parse diagnostics on stream completion so they don't leak
    // into a future stream. On error paths the catch block already consumed
    // them; this handles the success path.
    clearLastSDKDiagnostic();
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

  // Package the approval request(s) at the end.
  // Always extract from streamProcessor regardless of stopReason so that
  // drainStreamWithResume can carry them across a resume boundary (the
  // resumed stream uses a fresh streamProcessor that won't have them).
  const allPending = Array.from(streamProcessor.pendingApprovals.values());
  const approvals: ApprovalRequest[] = allPending.map((a) => ({
    toolCallId: a.toolCallId,
    toolName: a.toolName || "",
    toolArgs: a.toolArgs || "{}",
  }));
  const approval: ApprovalRequest | null = approvals[0] || null;
  streamProcessor.pendingApprovals.clear();

  if (stopReason === "requires_approval" && approvals.length === 0) {
    debugWarn(
      "drainStream",
      "No approvals collected despite requires_approval stop reason",
    );
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
  const streamRequestContext = getStreamRequestContext(stream);
  const client = await getClient();

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

  let runIdToResume = result.lastRunId ?? null;

  // If the stream failed before exposing run_id, try to discover the latest
  // running/created run for this conversation that was created after send start.
  if (
    result.stopReason === "error" &&
    !runIdToResume &&
    streamRequestContext &&
    abortSignal &&
    !abortSignal.aborted
  ) {
    try {
      runIdToResume = await discoverFallbackRunIdWithTimeout(
        client,
        streamRequestContext,
      );
      if (runIdToResume) {
        result.lastRunId = runIdToResume;
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

  // If stream ended without proper stop_reason and we have resume info, try once to reconnect
  // Only resume if we have an abortSignal AND it's not aborted (explicit check prevents
  // undefined abortSignal from accidentally allowing resume after user cancellation)
  if (
    result.stopReason === "error" &&
    runIdToResume &&
    abortSignal &&
    !abortSignal.aborted
  ) {
    // Preserve original state in case resume needs to merge or fails
    const originalFallbackError = result.fallbackError;
    const originalApprovals = result.approvals;
    const originalApproval = result.approval;

    // Log that we're attempting a stream resume
    telemetry.trackError(
      "stream_resume_attempt",
      originalFallbackError || "Stream error (no client-side detail)",
      "stream_resume",
      {
        runId: result.lastRunId ?? undefined,
      },
    );

    try {
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
        runIdToResume,
        {
          // If lastSeqId is null the stream failed before any seq_id-bearing
          // chunk arrived; use 0 to replay the run from the beginning.
          starting_after: result.lastSeqId ?? 0,
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

      // The resumed stream uses a fresh streamProcessor that won't have
      // approval_request_message chunks from before the disconnect (they
      // had seq_id <= lastSeqId). Carry them over from the original drain.
      if (
        result.stopReason === "requires_approval" &&
        (result.approvals?.length ?? 0) === 0 &&
        (originalApprovals?.length ?? 0) > 0
      ) {
        result.approvals = originalApprovals;
        result.approval = originalApproval;
      }
    } catch (resumeError) {
      // Resume failed - stick with the error stop_reason
      // Restore the original stream error for display
      result.fallbackError = originalFallbackError;

      const resumeErrorMsg =
        resumeError instanceof Error
          ? resumeError.message
          : String(resumeError);
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
    if (!result.lastRunId) skipReasons.push("no_run_id");
    if (!abortSignal) skipReasons.push("no_abort_signal");
    if (abortSignal?.aborted) skipReasons.push("user_aborted");

    // Only log if we actually skipped for a reason (i.e., we didn't enter the resume branch above)
    if (skipReasons.length > 0) {
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

  // Update duration to reflect total time (including resume attempt)
  result.apiDurationMs = performance.now() - overallStartTime;

  return result;
}
