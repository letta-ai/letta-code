import { Letta } from "@letta-ai/letta-client";
import {
  type createBuffers,
  markCurrentLineAsFinished,
  onChunk,
} from "./accumulator";

export type ApprovalRequest = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

type DrainResult = {
  stopReason: Letta.StopReasonType;
  lastRunId?: string | null;
  lastSeqId?: number | null;
  approval?: ApprovalRequest | null; // present only if we ended due to approval
};

export async function drainStream(
  stream: AsyncIterable<Letta.LettaStreamingResponse>,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
): Promise<DrainResult> {
  let approvalRequestId: string | null = null;
  let toolCallId: string | null = null;
  let toolName: string | null = null;
  let toolArgs: string | null = null;

  let stopReason: Letta.StopReasonType | null = null;
  let lastRunId: string | null = null;
  let lastSeqId: number | null = null;

  for await (const chunk of stream) {
    // Store the runId and seqId to re-connect if stream is interrupted
    if ("runId" in chunk && "seqId" in chunk && chunk.runId && chunk.seqId) {
      lastRunId = chunk.runId;
      lastSeqId = chunk.seqId;
    }

    if (chunk.messageType === "ping") continue;

    // Need to store the approval request ID to send an approval in a new run
    if (chunk.messageType === "approval_request_message") {
      approvalRequestId = chunk.id;
    }

    // NOTE: this this a little ugly - we're basically processing tool name and chunk deltas
    // in both the onChunk handler and here, we could refactor to instead pull the tool name
    // and JSON args from the mutated lines (eg last mutated line)
    if (
      chunk.messageType === "tool_call_message" ||
      chunk.messageType === "approval_request_message"
    ) {
      if (chunk.toolCall?.toolCallId) {
        toolCallId = chunk.toolCall.toolCallId;
      }
      if (chunk.toolCall?.name) {
        if (toolName) {
          // TODO would expect that we should allow stacking? I guess not?
          //   toolName = toolName + chunk.toolCall.name;
        } else {
          toolName = chunk.toolCall.name;
        }
      }
      if (chunk.toolCall?.arguments) {
        if (toolArgs) {
          toolArgs = toolArgs + chunk.toolCall.arguments;
        } else {
          toolArgs = chunk.toolCall.arguments;
        }
      }
    }

    onChunk(buffers, chunk);
    queueMicrotask(refresh);

    if (chunk.messageType === "stop_reason") {
      stopReason = chunk.stopReason;
      break; // end of turn
    }
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

  if (!stopReason) {
    stopReason = Letta.StopReasonType.Error;
  }

  return { stopReason, approval, lastRunId, lastSeqId };
}
