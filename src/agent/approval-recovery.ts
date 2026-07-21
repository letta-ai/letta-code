/**
 * Approval recovery helpers.
 *
 * Pure policy logic lives in `./turn-recovery-policy.ts` and is re-exported
 * here for backward compatibility. Async helpers that require backend access
 * stay in this module.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import {
  rebuildInputWithFreshDenials,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "./turn-recovery-policy";

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
  buildFreshDenialApprovals,
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
  refreshInputOtidsForNewRequest,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
  shouldRetryPostStreamRunError,
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
    const run = await getBackend().retrieveRun(runId);
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

export async function rebuildInputForApprovalResync(
  agentId: string,
  conversationId: string,
  currentInput: Array<MessageCreate | ApprovalCreate>,
): Promise<Array<MessageCreate | ApprovalCreate>> {
  const backend = getBackend();
  const agent = await backend.retrieveAgent(agentId);
  const { pendingApprovals } = await getResumeDataFromBackend(
    agent,
    conversationId,
  );
  const rebuilt = rebuildInputWithFreshDenials(
    currentInput,
    pendingApprovals ?? [],
    STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  );
  if (rebuilt.length === 0) {
    throw new Error("Approval resync produced no retryable input");
  }
  return rebuilt;
}
