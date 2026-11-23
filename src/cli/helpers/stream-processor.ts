import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
  messageId?: string;
}

export interface ErrorInfo {
  message: string;
  error_type?: string;
  error_code?: string;
  status_code?: number;
  retryable?: boolean;
  detail?: string;
  run_id?: string;
}

type StructuredLettaErrorMessage = LettaStreamingResponse.LettaErrorMessage & {
  error_code?: string;
  status_code?: number;
  retryable?: boolean;
};

export interface ChunkProcessingResult {
  shouldOutput: boolean;

  errorInfo?: ErrorInfo;

  updatedApproval?: ApprovalRequest;
}

export interface StreamSequenceCursor {
  runId: string;
  seqId: number;
}

export function advanceStreamSequenceCursor(
  cursor: StreamSequenceCursor | null,
  runId: string | null | undefined,
  seqId: number | null | undefined,
): StreamSequenceCursor | null {
  if (!runId || seqId == null) return cursor;
  return {
    runId,
    seqId: cursor?.runId === runId ? Math.max(cursor.seqId, seqId) : seqId,
  };
}

export class StreamProcessor {
  public pendingApprovals = new Map<string, ApprovalRequest>();
  public runIds = new Set<string>();
  public lastRunId: string | null = null;
  public lastSeqId: number | null = null;
  public stopReason: StopReasonType | null = null;
  public lastErrorInfo: ErrorInfo | undefined;

  constructor(
    private readonly seenSequenceCursor: StreamSequenceCursor | null = null,
  ) {}

  processChunk(chunk: LettaStreamingResponse): ChunkProcessingResult {
    let errorInfo: ErrorInfo | undefined;
    let updatedApproval: ApprovalRequest | undefined;
    const cursor = this.seenSequenceCursor;

    if (
      "seq_id" in chunk &&
      chunk.seq_id != null &&
      "run_id" in chunk &&
      cursor &&
      chunk.run_id === cursor.runId &&
      chunk.seq_id <= cursor.seqId
    ) {
      return { shouldOutput: false };
    }

    if ("run_id" in chunk && chunk.run_id) {
      this.runIds.add(chunk.run_id);
      this.lastRunId = chunk.run_id;
    }

    if ("seq_id" in chunk && chunk.seq_id != null) {
      this.lastSeqId = chunk.seq_id;
    }

    if (chunk.message_type === "ping") {
      return { shouldOutput: false };
    }
    if (
      (chunk as { message_type?: string }).message_type === "response_state"
    ) {
      return { shouldOutput: false };
    }

    if ("message_type" in chunk && chunk.message_type === "error_message") {
      const apiError = chunk as StructuredLettaErrorMessage;
      errorInfo = {
        message: apiError.message,
        error_type: apiError.error_type,
        error_code: apiError.error_code,
        status_code: apiError.status_code,
        retryable: apiError.retryable,
        detail: apiError.detail,
        run_id: this.lastRunId || undefined,
      };
    }
    const chunkWithError = chunk as typeof chunk & {
      error?: { message?: string; detail?: string };
    };
    if (chunkWithError.error && !("message_type" in chunk)) {
      const errorText = chunkWithError.error.message || "An error occurred";
      const errorDetail = chunkWithError.error.detail || "";
      errorInfo = {
        message: errorDetail ? `${errorText}: ${errorDetail}` : errorText,
        detail: errorDetail || undefined,
        run_id: this.lastRunId || undefined,
      };
    }

    if (errorInfo) this.lastErrorInfo = errorInfo;

    if (
      errorInfo?.message?.includes(
        "No tool call is currently awaiting approval",
      )
    ) {
      return { shouldOutput: false, errorInfo };
    }

    if (chunk.message_type === "tool_return_message") {
      if (chunk.tool_call_id) {
        this.pendingApprovals.delete(chunk.tool_call_id);
      }
    }

    if (chunk.message_type === "approval_request_message") {
      const toolCalls = Array.isArray(chunk.tool_calls)
        ? chunk.tool_calls
        : chunk.tool_call
          ? [chunk.tool_call]
          : [];

      for (const toolCall of toolCalls) {
        const toolCallId = toolCall?.tool_call_id;
        if (!toolCallId) continue;
        const id = toolCallId;

        const existing = this.pendingApprovals.get(id) || {
          toolCallId: id,
          toolName: "",
          toolArgs: "",
        };

        if ("id" in chunk && typeof chunk.id === "string" && chunk.id) {
          existing.messageId = chunk.id;
        }

        if (toolCall.name) {
          existing.toolName = toolCall.name;
        }

        if (toolCall.arguments) {
          existing.toolArgs += toolCall.arguments;
        }

        this.pendingApprovals.set(id, existing);
        updatedApproval = existing;
      }
    }

    if (chunk.message_type === "stop_reason") {
      this.stopReason = chunk.stop_reason;
    }

    return { shouldOutput: true, errorInfo, updatedApproval };
  }

  getApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map((a) => ({
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      toolArgs: a.toolArgs,
      ...(a.messageId ? { messageId: a.messageId } : {}),
    }));
  }
}
