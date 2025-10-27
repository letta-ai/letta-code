import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { LettaStreamingChunk } from "../../agent/message";
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
  stream: AsyncIterable<LettaStreamingChunk>,
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
