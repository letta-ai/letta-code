import {
  isApprovalPendingError,
  isInvalidToolCallIdsError,
  shouldAttemptApprovalRecovery,
} from "@/agent/turn-recovery-policy";
import { MAX_POST_STOP_APPROVAL_RECOVERY } from "./constants";

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
