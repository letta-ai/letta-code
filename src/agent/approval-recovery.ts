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
import { type ConversationMessageStreamBody, getBackend } from "@/backend";
import {
  rebuildInputWithFreshDenials,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "./turn-recovery-policy";

const ACTIVE_BLOCKING_RUN_STATUSES = new Set(["created", "running", "pending"]);
const TERMINAL_BLOCKING_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const CONVERSATION_BUSY_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
export const CONVERSATION_BUSY_POLL_INTERVAL_MS = 5000;

export type BlockingRunWaitResult = "settled" | "timed_out" | "unavailable";

interface BlockingRunWaitOptions {
  deadlineMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  retrieveRun?: (
    runId: string,
    options?: {
      signal?: AbortSignal;
      maxRetries?: number;
      timeout?: number;
    },
  ) => Promise<{ status?: unknown }>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunErrorInfo {
  error_type?: string;
  error_code?: string;
  status_code?: number;
  retryable?: boolean;
  message?: string;
  detail?: string;
  raw?: unknown;
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
  extractConversationBusyRunId,
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

async function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    function onAbort() {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Cancelled by user"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait for a server-named conversation lock owner to finish. Callers keep one
 * absolute deadline across successive blocker ids so healthy rotating runs do
 * not consume the generic three-attempt fallback budget or wait forever.
 */
export async function waitForConversationBusyRun(
  runId: string,
  signal?: AbortSignal,
  options: BlockingRunWaitOptions = {},
): Promise<BlockingRunWaitResult> {
  const now = options.now ?? Date.now;
  const deadlineMs =
    options.deadlineMs ?? now() + CONVERSATION_BUSY_WAIT_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? CONVERSATION_BUSY_POLL_INTERVAL_MS;
  const retrieveRun =
    options.retrieveRun ??
    ((id, requestOptions) =>
      getBackend().retrieveRun(id, requestOptions) as Promise<{
        status?: unknown;
      }>);
  const sleep = options.sleep ?? sleepWithAbort;

  while (true) {
    signal?.throwIfAborted();
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) return "timed_out";

    let status: unknown;
    try {
      status = (
        await retrieveRun(runId, {
          signal,
          maxRetries: 0,
          timeout: Math.min(remainingMs, pollIntervalMs),
        })
      ).status;
    } catch {
      signal?.throwIfAborted();
      return "unavailable";
    }

    if (TERMINAL_BLOCKING_RUN_STATUSES.has(String(status))) {
      const delayMs = Math.min(pollIntervalMs, deadlineMs - now());
      if (delayMs <= 0) return "timed_out";
      await sleep(delayMs, signal);
      return "settled";
    }
    if (!ACTIVE_BLOCKING_RUN_STATUSES.has(String(status))) return "unavailable";

    const delayMs = Math.min(pollIntervalMs, deadlineMs - now());
    if (delayMs <= 0) return "timed_out";
    await sleep(delayMs, signal);
  }
}

export async function waitForConversationBusyRunOrThrow(
  runId: string,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<boolean> {
  const result = await waitForConversationBusyRun(runId, signal, {
    deadlineMs,
  });
  if (result === "timed_out") {
    throw new Error(
      `Conversation is still busy because run ${runId} did not finish before the recovery deadline`,
    );
  }
  return result === "settled";
}

/** Resume only the rejected request's OTID; a missing lookup is not success. */
export async function resumeConversationBusyRequest(
  conversationId: string,
  agentId: string | undefined,
  input: Array<MessageCreate | ApprovalCreate>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const otid = input
    .map((item) => (item as Record<string, unknown>).otid)
    .find((value): value is string => typeof value === "string");
  if (!otid) return null;

  try {
    return await getBackend().streamConversationMessages(
      conversationId,
      {
        agent_id: conversationId === "default" ? agentId : undefined,
        otid,
        starting_after: 0,
        batch_size: 1000,
      } as unknown as ConversationMessageStreamBody,
      signal ? { signal } : undefined,
    );
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

type RunErrorMetadata =
  | {
      type?: string;
      error_type?: string;
      errorCode?: string;
      error_code?: string;
      status_code?: number;
      retryable?: boolean;
      message?: string;
      detail?: string;
      raw?: unknown;
      run_id?: string;
      error?: {
        type?: string;
        error_type?: string;
        errorCode?: string;
        error_code?: string;
        status_code?: number;
        retryable?: boolean;
        message?: string;
        detail?: string;
        raw?: unknown;
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
      error_code:
        metaError?.errorCode ??
        metaError?.error_code ??
        nestedError?.errorCode ??
        nestedError?.error_code,
      status_code: metaError?.status_code ?? nestedError?.status_code,
      retryable: metaError?.retryable ?? nestedError?.retryable,
      message: metaError?.message ?? nestedError?.message,
      detail: metaError?.detail ?? nestedError?.detail,
      raw: metaError?.raw ?? nestedError?.raw,
      run_id: metaError?.run_id ?? nestedError?.run_id ?? runId,
    };

    return errorInfo.error_type ||
      errorInfo.error_code ||
      errorInfo.message ||
      errorInfo.detail
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
