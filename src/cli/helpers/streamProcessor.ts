import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";

// ============================================================================
// TYPES
// ============================================================================

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
}

export interface ErrorInfo {
  message: string;
  error_type?: string;
  detail?: string;
  run_id?: string;
}

export interface ChunkProcessingResult {
  /** Whether this chunk should be output to the user */
  shouldOutput: boolean;

  /** If this is an error chunk, formatted error message */
  errorInfo?: ErrorInfo;

  /** If this chunk updated an approval, the current state */
  updatedApproval?: ApprovalRequest;
}

// ============================================================================
// STREAM PROCESSOR
// ============================================================================

export class StreamProcessor {
  // State tracking (public for easy access - wrapper decides usage)
  public pendingApprovals = new Map<string, ApprovalRequest>();
  public runIds = new Set<string>();
  public lastRunId: string | null = null;
  public lastSeqId: number | null = null;
  public stopReason: StopReasonType | null = null;

  processChunk(chunk: LettaStreamingResponse): ChunkProcessingResult {
    let errorInfo: ErrorInfo | undefined;
    let updatedApproval: ApprovalRequest | undefined;
    // Store the run_id (for error reporting) and seq_id (for stream resumption)
    // Capture run_id even if seq_id is missing - we need it for error details
    if ("run_id" in chunk && chunk.run_id) {
      this.runIds.add(chunk.run_id);
      this.lastRunId = chunk.run_id;
    }

    // Track seq_id (drainStream line 122-124)
    if ("seq_id" in chunk && chunk.seq_id != null) {
      this.lastSeqId = chunk.seq_id;
    }

    // Skip ping messages (drainStream line 126)
    if (chunk.message_type === "ping") {
      return { shouldOutput: false };
    }

    // Detect mid-stream errors
    // Case 1: LettaErrorMessage from the API (has message_type: "error_message")
    if ("message_type" in chunk && chunk.message_type === "error_message") {
      // This is a LettaErrorMessage
      const apiError = chunk as LettaStreamingResponse.LettaErrorMessage;
      errorInfo = {
        message: apiError.message,
        error_type: apiError.error_type,
        detail: apiError.detail,
        run_id: this.lastRunId || undefined,
      };
    }
    // Case 2: Generic error object without message_type
    const chunkWithError = chunk as typeof chunk & {
      error?: { message?: string; detail?: string };
    };
    if (chunkWithError.error && !("message_type" in chunk)) {
      const errorText = chunkWithError.error.message || "An error occurred";
      const errorDetail = chunkWithError.error.detail || "";
      errorInfo = {
        message: errorDetail ? `${errorText}: ${errorDetail}` : errorText,
        run_id: this.lastRunId || undefined,
      };
    }

    // Suppress mid-stream desync errors (match headless behavior)
    // These are transient and will be handled by end-of-turn desync recovery
    if (
      errorInfo?.message?.includes(
        "No tool call is currently awaiting approval",
      )
    ) {
      // Server isn't ready for approval yet; let the stream continue until it is
      // Suppress the error frame from output
      return { shouldOutput: false, errorInfo };
    }

    // Remove tool from pending approvals when it completes (server-side execution finished)
    // This means the tool was executed server-side and doesn't need approval
    if (chunk.message_type === "tool_return_message") {
      if (chunk.tool_call_id) {
        this.pendingApprovals.delete(chunk.tool_call_id);
      }
      // Continue processing this chunk (for UI display)
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
        const toolCallId = toolCall?.tool_call_id;
        if (!toolCallId) continue; // contract: approval chunks include tool_call_id
        const id = toolCallId;

        // Get or create entry for this tool_call_id
        const existing = this.pendingApprovals.get(id) || {
          toolCallId: id,
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

        this.pendingApprovals.set(id, existing);
        updatedApproval = existing;
      }
    }

    if (chunk.message_type === "stop_reason") {
      this.stopReason = chunk.stop_reason;
      // Continue reading stream to get usage_statistics that may come after
    }

    // Default: output this chunk
    return { shouldOutput: true, errorInfo, updatedApproval };
  }

  /**
   * Get accumulated approvals as array
   */
  getApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map((a) => ({
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      toolArgs: a.toolArgs,
    }));
  }
}
