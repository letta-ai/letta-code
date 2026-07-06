import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { shouldRetryPostStreamRunError } from "@/agent/approval-recovery";
import { getBackend } from "@/backend";

// Check if error is retriable based on stop reason and run metadata
export async function isRetriableError(
  stopReason: StopReasonType,
  lastRunId: string | null | undefined,
  fallbackDetail?: string | null,
): Promise<boolean> {
  // Early exit for stop reasons that should never be retried
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

  // Fallback check: for error-like stop_reasons, check metadata for retriable patterns
  // This handles cases where the backend sends a generic error stop_reason but the
  // underlying cause is a transient LLM/network issue that should be retried.
  // llm_api_error is only retried by default after explicit non-retryable run
  // metadata, such as auth failures, has had a chance to opt out.
  if (lastRunId) {
    try {
      const run = await getBackend().retrieveRun(lastRunId);
      const metaError = run.metadata?.error as
        | {
            error_type?: string;
            detail?: string;
            retryable?: boolean;
            // Handle nested error structure (error.error) that can occur in some edge cases
            error?: {
              error_type?: string;
              detail?: string;
              retryable?: boolean;
            };
          }
        | undefined;

      // Check for llm_error at top level or nested (handles error.error nesting)
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
