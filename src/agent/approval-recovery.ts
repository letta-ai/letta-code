/**
 * Approval recovery helpers.
 *
 * Pure policy logic lives in `./turn-recovery-policy.ts` and is re-exported
 * here for backward compatibility. This module keeps only the async/side-effect
 * helper (`fetchRunErrorDetail`) that requires network access.
 */

import { getClient } from "./client";

export interface RunErrorInfo {
  error_type?: string;
  message?: string;
  detail?: string;
  run_id?: string;
}

export type {
  PendingApprovalInfo,
  PreStreamConflictKind,
  PreStreamErrorAction,
  PreStreamErrorOptions,
  RetryDelayCategory,
} from "./turn-recovery-policy";
// ── Re-export pure policy helpers (single source of truth) ──────────
export {
  classifyPreStreamConflict,
  extractConflictDetail,
  getPreStreamErrorAction,
  getRetryDelayMs,
  getTransientRetryDelayMs,
  isApprovalPendingError,
  isConversationBusyError,
  isEmptyResponseError,
  isEmptyResponseRetryable,
  isInvalidToolCallIdsError,
  isNonRetryableProviderErrorDetail,
  isQuotaLimitErrorDetail,
  isRetryableProviderErrorDetail,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  shouldAttemptApprovalRecovery,
  shouldRetryPreStreamTransientError,
  shouldRetryRunMetadataError,
} from "./turn-recovery-policy";

// ── Async helpers (network side effects — stay here) ────────────────

type RunErrorMetadata =
  | {
      type?: string;
      error_type?: string;
      message?: string;
      detail?: string;
      run_id?: string;
      error?: {
        type?: string;
        error_type?: string;
        message?: string;
        detail?: string;
        run_id?: string;
      };
    }
  | undefined
  | null;

export async function fetchRunErrorInfo(
  runId: string | null | undefined,
): Promise<RunErrorInfo | null> {
  if (!runId) return null;
  try {
    const client = await getClient();
    const run = await client.runs.retrieve(runId);
    const metaError = run.metadata?.error as RunErrorMetadata;
    const nestedError = metaError?.error;
    const errorInfo: RunErrorInfo = {
      error_type:
        metaError?.error_type ??
        metaError?.type ??
        nestedError?.error_type ??
        nestedError?.type,
      message: metaError?.message ?? nestedError?.message,
      detail: metaError?.detail ?? nestedError?.detail,
      run_id: metaError?.run_id ?? nestedError?.run_id ?? runId,
    };

    return errorInfo.error_type || errorInfo.message || errorInfo.detail
      ? errorInfo
      : null;
  } catch {
    return null;
  }
}

export async function fetchRunErrorDetail(
  runId: string | null | undefined,
): Promise<string | null> {
  const errorInfo = await fetchRunErrorInfo(runId);
  return errorInfo?.detail ?? errorInfo?.message ?? null;
}
