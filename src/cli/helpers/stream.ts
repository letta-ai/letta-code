import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { getClient } from "../../agent/client";

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
  approval?: ApprovalRequest | null; // present only if we ended due to approval
  apiDurationMs: number; // time spent in API call
};

export async function drainStream(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
): Promise<DrainResult> {
  const startTime = performance.now();

  let approvalRequestId: string | null = null;
  let toolCallId: string | null = null;
  let toolName: string | null = null;
  let toolArgs: string | null = null;

  let stopReason: StopReasonType | null = null;
  let lastRunId: string | null = null;
  let lastSeqId: number | null = null;

  for await (const chunk of stream) {
    // console.log("chunk", chunk);

    // Check if stream was aborted
    if (abortSignal?.aborted) {
      stopReason = "cancelled";
      // Mark incomplete tool calls as cancelled to prevent stuck blinking UI
      markIncompleteToolsAsCancelled(buffers);
      queueMicrotask(refresh);
      break;
    }
    // Store the run_id and seq_id to re-connect if stream is interrupted
    if (
      "run_id" in chunk &&
      "seq_id" in chunk &&
      chunk.run_id &&
      chunk.seq_id
    ) {
      lastRunId = chunk.run_id;
      lastSeqId = chunk.seq_id;
    }

    if (chunk.message_type === "ping") continue;

    // Need to store the approval request ID to send an approval in a new run
    if (chunk.message_type === "approval_request_message") {
      approvalRequestId = chunk.id;
    }

    // NOTE: this this a little ugly - we're basically processing tool name and chunk deltas
    // in both the onChunk handler and here, we could refactor to instead pull the tool name
    // and JSON args from the mutated lines (eg last mutated line)
    if (
      chunk.message_type === "tool_call_message" ||
      chunk.message_type === "approval_request_message"
    ) {
      // Use deprecated tool_call or new tool_calls array
      const toolCall =
        chunk.tool_call ||
        (Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0
          ? chunk.tool_calls[0]
          : null);

      if (toolCall?.tool_call_id) {
        toolCallId = toolCall.tool_call_id;
      }
      if (toolCall?.name) {
        if (toolName) {
          // TODO would expect that we should allow stacking? I guess not?
          //   toolName = toolName + toolCall.name;
        } else {
          toolName = toolCall.name;
        }
      }
      if (toolCall?.arguments) {
        if (toolArgs) {
          toolArgs = toolArgs + toolCall.arguments;
        } else {
          toolArgs = toolCall.arguments;
        }
      }
    }

    onChunk(buffers, chunk);
    queueMicrotask(refresh);

    if (chunk.message_type === "stop_reason") {
      stopReason = chunk.stop_reason;
      // Continue reading stream to get usage_statistics that may come after
    }
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

  // Package the approval request at the end
  const approval =
    toolCallId && toolName && toolArgs && approvalRequestId
      ? {
          toolCallId: toolCallId,
          toolName: toolName,
          toolArgs: toolArgs,
        }
      : null;

  const apiDurationMs = performance.now() - startTime;

  return { stopReason, approval, lastRunId, lastSeqId, apiDurationMs };
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
 * @returns Result with stop_reason, approval info, and timing
 */
export async function drainStreamWithResume(
  stream: Stream<LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal?: AbortSignal,
): Promise<DrainResult> {
  const overallStartTime = performance.now();

  // Attempt initial drain
  let result = await drainStream(stream, buffers, refresh, abortSignal);

  // If stream ended without proper stop_reason and we have resume info, try once to reconnect
  if (
    result.stopReason === "error" &&
    result.lastRunId &&
    result.lastSeqId !== null &&
    !abortSignal?.aborted
  ) {
    try {
      const client = await getClient();
      // Resume from Redis where we left off
      const resumeStream = await client.runs.messages.stream(result.lastRunId, {
        starting_after: result.lastSeqId,
        batch_size: 1000, // Fetch buffered chunks quickly
      });

      // Continue draining from where we left off
      const resumeResult = await drainStream(
        resumeStream,
        buffers,
        refresh,
        abortSignal,
      );

      // Use the resume result (should have proper stop_reason now)
      result = resumeResult;
    } catch (e) {
      // Resume failed - stick with the error stop_reason
      // The original error result will be returned
    }
  }

  // Update duration to reflect total time (including resume attempt)
  result.apiDurationMs = performance.now() - overallStartTime;

  return result;
}
