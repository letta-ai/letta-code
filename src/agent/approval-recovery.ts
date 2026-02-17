/**
 * Approval recovery helpers.
 *
 * Pure policy logic lives in `./turn-recovery-policy.ts` and is re-exported
 * here for backward compatibility. This module keeps only the async/side-effect
 * helper (`fetchRunErrorDetail`) that requires network access.
 */

import { getClient } from "./client";

export type {
  PendingApprovalInfo,
  PreStreamConflictKind,
  PreStreamErrorAction,
  PreStreamErrorOptions,
} from "./turn-recovery-policy";
// ── Re-export pure policy helpers (single source of truth) ──────────
export {
  classifyPreStreamConflict,
  extractConflictDetail,
  getPreStreamErrorAction,
  isApprovalPendingError,
  isConversationBusyError,
  isInvalidToolCallIdsError,
  isNonRetryableProviderErrorDetail,
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
      error_type?: string;
      message?: string;
      detail?: string;
      error?: { error_type?: string; message?: string; detail?: string };
    }
  | undefined
  | null;

export async function fetchRunErrorDetail(
  runId: string | null | undefined,
): Promise<string | null> {
  if (!runId) return null;
  try {
    const client = await getClient();
    const run = await client.runs.retrieve(runId);
    const metaError = run.metadata?.error as RunErrorMetadata;

    return (
      metaError?.detail ??
      metaError?.message ??
      metaError?.error?.detail ??
      metaError?.error?.message ??
      null
    );
  } catch {
    return null;
  }
}
