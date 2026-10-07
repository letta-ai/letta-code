import {
  isApprovalPendingError,
  isInvalidToolCallIdsError,
  shouldAttemptApprovalRecovery,
  shouldRetryPostStreamRunError,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import type { StopReasonType } from "@/types/protocol_v2";
import { MAX_POST_STOP_APPROVAL_RECOVERY } from "./constants";

export async function isRetriablePostStopError(
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

  if (!lastRunId) {
    return shouldRetryPostStreamRunError({
      stopReason,
      detail: fallbackDetail,
    });
  }

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
    return shouldRetryPostStreamRunError({
      stopReason,
      errorType: metaError?.error_type ?? metaError?.error?.error_type,
      detail: metaError?.detail ?? metaError?.error?.detail,
      retryable: metaError?.retryable ?? metaError?.error?.retryable,
    });
  } catch {
    return shouldRetryPostStreamRunError({
      stopReason,
      detail: fallbackDetail,
    });
  }
}

export function isApprovalToolCallDesyncError(detail: unknown): boolean {
  return isInvalidToolCallIdsError(detail) || isApprovalPendingError(detail);
}

export function getApprovalToolCallDesyncErrorText(errorInfo: {
  detail?: unknown;
  message?: unknown;
}): string | null {
  const detail = errorInfo.detail;
  if (typeof detail === "string" && isApprovalToolCallDesyncError(detail)) {
    return detail;
  }
  const message = errorInfo.message;
  if (typeof message === "string" && isApprovalToolCallDesyncError(message)) {
    return message;
  }
  return null;
}

export function shouldAttemptPostStopApprovalRecovery(params: {
  stopReason: string | null | undefined;
  runIdsSeen: number;
  retries: number;
  runErrorDetail: string | null;
  latestErrorText: string | null;
  fallbackError?: string | null;
}): boolean {
  const approvalDesyncDetected =
    isApprovalToolCallDesyncError(params.runErrorDetail) ||
    isApprovalToolCallDesyncError(params.latestErrorText) ||
    isApprovalToolCallDesyncError(params.fallbackError);
  return shouldAttemptApprovalRecovery({
    approvalPendingDetected: approvalDesyncDetected,
    retries: params.retries,
    maxRetries: MAX_POST_STOP_APPROVAL_RECOVERY,
  });
}
