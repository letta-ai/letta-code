import { telemetry } from "@/telemetry";
import { BusyRecoveryBudget } from "./busy-recovery-budget";

let budget = new BusyRecoveryBudget();
export function __testResetBusyRecoveryBudget(): void {
  budget = new BusyRecoveryBudget();
}

export type BusyRecoveryPhase =
  | "stream_waiting"
  | "stream_progress"
  | "stream_eof"
  | "stream_failed"
  | "stream_cancelled"
  | "stream_closed"
  | "retry_budget_exhausted"
  | "retry_selected"
  | "send_rejected"
  | "replay_started"
  | "replay_attached"
  | "replay_unavailable"
  | "replay_missing_otid"
  | "poll_started"
  | "poll_settled"
  | "poll_failed"
  | "poll_unknown_status"
  | "poll_timed_out"
  | "cancelled";

interface BusyRecoveryFields {
  conversationId?: string;
  requestRunId?: string;
  retryCount?: number;
  stopReason?: unknown;
  otid?: string;
  blockerRunId?: string;
  httpStatus?: number;
  pollCount?: number;
  elapsedMs?: number;
  runStatus?: unknown;
  chunkCount?: number;
  idleMs?: number;
  lastChunkType?: unknown;
  readPending?: boolean;
}

export function isBusyRecoveryEnabled(): boolean {
  return (
    !["0", "false"].includes(process.env.LETTA_CODE_TELEM ?? "") &&
    process.env.DO_NOT_TRACK !== "1"
  );
}

/** Fixed text and allowlisted fields only: never include errors or debug tails. */
export function reportBusyRecovery(
  phase: BusyRecoveryPhase,
  fields: BusyRecoveryFields = {},
): void {
  try {
    if (!isBusyRecoveryEnabled()) return;
    const safeId = (value: string | undefined) =>
      typeof value === "string" && value && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
        ? value
        : undefined;
    const count = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    if (
      !budget.allow(phase, {
        conversationId: safeId(fields.conversationId),
        otid: safeId(fields.otid),
        blockerRunId: safeId(fields.blockerRunId),
      })
    )
      return;
    telemetry.trackError(
      "conversation_busy_recovery",
      "Conversation busy recovery diagnostic",
      JSON.stringify({
        phase,
        client_timestamp: new Date().toISOString(),
        conversation_id: safeId(fields.conversationId),
        request_otid: safeId(fields.otid),
        blocker_run_id: safeId(fields.blockerRunId),
        request_run_id: safeId(fields.requestRunId),
        retry_count: count(fields.retryCount),
        chunk_count: count(fields.chunkCount),
        read_pending:
          typeof fields.readPending === "boolean"
            ? fields.readPending
            : undefined,
        idle_ms: count(fields.idleMs),
        last_chunk_type:
          typeof fields.lastChunkType === "string" &&
          [
            "reasoning_message",
            "assistant_message",
            "tool_call_message",
            "tool_return_message",
            "approval_request_message",
            "ping",
            "stop_reason",
            "usage_statistics",
          ].includes(fields.lastChunkType)
            ? fields.lastChunkType
            : undefined,
        stop_reason:
          typeof fields.stopReason === "string" &&
          [
            "end_turn",
            "error",
            "llm_api_error",
            "max_steps",
            "max_tokens_exceeded",
            "invalid_llm_response",
            "invalid_tool_call",
            "no_tool_call",
            "tool_rule",
            "insufficient_credits",
            "context_window_overflow_in_system_prompt",
            "requires_approval",
            "cancelled",
          ].includes(fields.stopReason)
            ? fields.stopReason
            : undefined,
        run_status:
          typeof fields.runStatus === "string" &&
          [
            "created",
            "running",
            "pending",
            "completed",
            "failed",
            "cancelled",
            "expired",
          ].includes(fields.runStatus)
            ? fields.runStatus
            : undefined,
        poll_count: count(fields.pollCount),
        elapsed_ms: count(fields.elapsedMs),
      }),
      {
        httpStatus:
          typeof fields.httpStatus === "number" &&
          Number.isInteger(fields.httpStatus) &&
          fields.httpStatus >= 100 &&
          fields.httpStatus <= 599
            ? fields.httpStatus
            : undefined,
        omitDebugLogTail: true,
      },
    );
  } catch {
    // Diagnostics must not change recovery behavior.
  }
}

export function getBusyRecoveryHttpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}
