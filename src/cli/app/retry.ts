import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { shouldRetryPostStreamRunError } from "@/agent/approval-recovery";
import { getBackend } from "@/backend";

export async function isRetriableError(
  stopReason: StopReasonType,
  lastRunId: string | null | undefined,
  fallbackDetail?: string | null,
): Promise<boolean> {
  const nonRetriableReasons: StopReasonType[] = [
    "cancelled",
    "requires_approval",
    "max_steps",
    "max_tokens_exceeded",
    "context_window_overflow_in_system_prompt",
    "end_turn",
    "tool_rule",
    "no_tool_call",
  ];
  if (nonRetriableReasons.includes(stopReason)) return false;

  if (lastRunId) {
    try {
      const run = await getBackend().retrieveRun(lastRunId);
      const metaError = run.metadata?.error as
        | {
            error_type?: string;
            detail?: string;
            retryable?: boolean;
            error?: {
              error_type?: string;
              detail?: string;
              retryable?: boolean;
            };
          }
        | undefined;

      const errorType = metaError?.error_type ?? metaError?.error?.error_type;
      const detail = metaError?.detail ?? metaError?.error?.detail;
      const retryable = metaError?.retryable ?? metaError?.error?.retryable;

      return shouldRetryPostStreamRunError({
        stopReason,
        errorType,
        detail,
        retryable,
      });
    } catch {
      return shouldRetryPostStreamRunError({
        stopReason,
        detail: fallbackDetail,
      });
    }
  }
  return shouldRetryPostStreamRunError({ stopReason, detail: fallbackDetail });
}
