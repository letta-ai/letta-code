/**
 * Pure, framework-agnostic policy helpers for turn-level recovery.
 *
 * Both TUI (App.tsx) and headless (headless.ts) consume these helpers
 * so that identical conflict inputs always produce the same recovery
 * action. No network calls, no React, no stream-json output.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { isCloudflareEdge52xHtmlError } from "../cli/helpers/errorFormatter";
import { isZaiNonRetryableError } from "../cli/helpers/zaiErrors";

// ── Error fragment constants ────────────────────────────────────────

const INVALID_TOOL_CALL_IDS_FRAGMENT = "invalid tool call ids";
const APPROVAL_PENDING_DETAIL_FRAGMENT = "waiting for approval";
const CONVERSATION_BUSY_DETAIL_FRAGMENT =
  "another request is currently being processed";
const EMPTY_RESPONSE_DETAIL_FRAGMENT = "empty content in";
const RETRYABLE_PROVIDER_DETAIL_PATTERNS = [
  "Anthropic API error",
  "OpenAI API error",
  "Google Vertex API error",
  "ChatGPT API error",
  "ChatGPT server error",
  "Connection error during Anthropic streaming",
  "Connection error during streaming",
  "upstream connect error",
  "connection termination",
  "peer closed connection",
  "incomplete chunked read",
  "Network error",
  "Connection error",
  "Request timed out",
  "overloaded",
  "api_error",
];
const NON_RETRYABLE_PROVIDER_DETAIL_PATTERNS = [
  "invalid api key",
  "incorrect api key",
  "authentication error",
  "unauthorized",
  "permission denied",
  "forbidden",
  "invalid_request_error",
  "invalid model",
  "model_not_found",
  "context_length_exceeded",
  "invalid_encrypted_content",
];
const NON_RETRYABLE_429_REASONS = [
  "agents-limit-exceeded",
  "exceeded-quota",
  "free-usage-exceeded",
  "premium-usage-exceeded",
  "standard-usage-exceeded",
  "basic-usage-exceeded",
  "not-enough-credits",
];
const NON_RETRYABLE_QUOTA_DETAIL_PATTERNS = [
  "hosted model usage limit",
  "out of credits",
  "usage_limit_reached",
];
const NON_RETRYABLE_4XX_PATTERN = /Error code:\s*4(0[0-8]|1\d|2\d|3\d|4\d|51)/i;
const RETRYABLE_429_PATTERN = /Error code:\s*429|rate limit|too many requests/i;
function isCloudflareEdge52xDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return isCloudflareEdge52xHtmlError(detail);
}

function hasNonRetryableQuotaDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const normalized = detail.toLowerCase();
  return (
    NON_RETRYABLE_429_REASONS.some((reason) => normalized.includes(reason)) ||
    NON_RETRYABLE_QUOTA_DETAIL_PATTERNS.some((pattern) =>
      normalized.includes(pattern),
    )
  );
}

// ── Classifiers ─────────────────────────────────────────────────────

/** Tool call IDs don't match what the server expects. */
export function isInvalidToolCallIdsError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(INVALID_TOOL_CALL_IDS_FRAGMENT);
}

/** Backend has a pending approval blocking new messages. */
export function isApprovalPendingError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(APPROVAL_PENDING_DETAIL_FRAGMENT);
}

/** Conversation is busy (another request is being processed). */
export function isConversationBusyError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(CONVERSATION_BUSY_DETAIL_FRAGMENT);
}

/**
 * LLM returned an empty response (no content and no tool calls).
 * This can happen with models like Opus 4.6 that occasionally return empty content.
 * These are retryable with a cache-busting system message modification.
 */
export function isEmptyResponseError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(EMPTY_RESPONSE_DETAIL_FRAGMENT);
}

/** Transient provider/network detail that is usually safe to retry. */
export function isRetryableProviderErrorDetail(detail: unknown): boolean {
  if (isCloudflareEdge52xDetail(detail)) return true;
  if (typeof detail !== "string") return false;
  return RETRYABLE_PROVIDER_DETAIL_PATTERNS.some((pattern) =>
    detail.includes(pattern),
  );
}

/** Non-transient auth/validation style provider detail that should not be retried. */
export function isNonRetryableProviderErrorDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  if (isZaiNonRetryableError(detail)) return true;
  const normalized = detail.toLowerCase();
  if (NON_RETRYABLE_4XX_PATTERN.test(detail)) return true;
  return NON_RETRYABLE_PROVIDER_DETAIL_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

/** Retry decision for run-metadata fallback classification. */
export function shouldRetryRunMetadataError(
  errorType: unknown,
  detail: unknown,
): boolean {
  const explicitLlmError = errorType === "llm_error";
  const nonRetryableQuotaDetail = hasNonRetryableQuotaDetail(detail);
  const retryable429Detail =
    typeof detail === "string" && RETRYABLE_429_PATTERN.test(detail);
  const retryableDetail = isRetryableProviderErrorDetail(detail);
  const nonRetryableDetail = isNonRetryableProviderErrorDetail(detail);

  if (nonRetryableQuotaDetail) return false;
  if (nonRetryableDetail && !retryable429Detail) return false;
  if (explicitLlmError) return true;
  return retryable429Detail || retryableDetail;
}

/**
 * Check if this is an empty response error that should be retried.
 *
 * Empty responses from models like Opus 4.6 are retryable. The caller
 * decides whether to retry with the same input or append a system
 * reminder nudge (typically on the last attempt).
 */
export function isEmptyResponseRetryable(
  errorType: unknown,
  detail: unknown,
  emptyResponseRetries: number,
  maxEmptyResponseRetries: number,
): boolean {
  if (emptyResponseRetries >= maxEmptyResponseRetries) return false;
  if (errorType !== "llm_error") return false;
  return isEmptyResponseError(detail);
}

/** Retry decision for pre-stream send failures before any chunks are yielded. */
export function shouldRetryPreStreamTransientError(opts: {
  status: number | undefined;
  detail: unknown;
}): boolean {
  const { status, detail } = opts;
  if (hasNonRetryableQuotaDetail(detail)) return false;

  if (status === 429) {
    return true;
  }
  if (status !== undefined && status >= 500) return true;
  if (status !== undefined && status >= 400) return false;

  const retryable429Detail =
    typeof detail === "string" && RETRYABLE_429_PATTERN.test(detail);
  if (retryable429Detail) return true;
  if (isNonRetryableProviderErrorDetail(detail)) return false;
  return isRetryableProviderErrorDetail(detail);
}

/** Parse Retry-After header to milliseconds (seconds or HTTP-date forms). */
export function parseRetryAfterHeaderMs(
  retryAfterValue: string | null | undefined,
): number | null {
  if (!retryAfterValue) return null;

  const seconds = Number(retryAfterValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryAtMs = Date.parse(retryAfterValue);
  if (Number.isNaN(retryAtMs)) return null;

  const delayMs = retryAtMs - Date.now();
  return delayMs > 0 ? delayMs : 0;
}

// ── Pre-stream conflict routing ─────────────────────────────────────

export type PreStreamConflictKind =
  | "approval_pending"
  | "conversation_busy"
  | null;

export type PreStreamErrorAction =
  | "resolve_approval_pending"
  | "retry_conversation_busy"
  | "retry_transient"
  | "rethrow";

export interface PreStreamErrorOptions {
  status?: number;
  transientRetries?: number;
  maxTransientRetries?: number;
}

/** Classify a pre-stream 409 conflict detail string. */
export function classifyPreStreamConflict(
  detail: unknown,
): PreStreamConflictKind {
  if (isApprovalPendingError(detail)) return "approval_pending";
  if (isConversationBusyError(detail)) return "conversation_busy";
  return null;
}

/** Determine the recovery action for a pre-stream 409 error. */
export function getPreStreamErrorAction(
  detail: unknown,
  conversationBusyRetries: number,
  maxConversationBusyRetries: number,
  opts?: PreStreamErrorOptions,
): PreStreamErrorAction {
  const kind = classifyPreStreamConflict(detail);

  if (kind === "approval_pending") {
    return "resolve_approval_pending";
  }

  if (
    kind === "conversation_busy" &&
    conversationBusyRetries < maxConversationBusyRetries
  ) {
    return "retry_conversation_busy";
  }

  if (
    opts &&
    shouldRetryPreStreamTransientError({ status: opts.status, detail }) &&
    (opts.transientRetries ?? 0) < (opts.maxTransientRetries ?? 0)
  ) {
    return "retry_transient";
  }

  return "rethrow";
}

// ── Error text extraction ───────────────────────────────────────────

/**
 * Extract error detail string from a pre-stream APIError's nested body.
 *
 * Handles the common SDK error shapes:
 * - Nested: `e.error.error.detail` → `e.error.error.message`
 * - Direct: `e.error.detail` → `e.error.message`
 * - Error: `e.message`
 *
 * Checks `detail` first (specific) then `message` (generic) at each level.
 */
export function extractConflictDetail(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    const errObj = (error as Record<string, unknown>).error;
    if (errObj && typeof errObj === "object") {
      const outer = errObj as Record<string, unknown>;
      // Nested: e.error.error.detail → e.error.error.message
      if (outer.error && typeof outer.error === "object") {
        const nested = outer.error as Record<string, unknown>;
        if (typeof nested.detail === "string") return nested.detail;
        if (typeof nested.message === "string") return nested.message;
      }
      // Direct: e.error.detail → e.error.message
      if (typeof outer.detail === "string") return outer.detail;
      if (typeof outer.message === "string") return outer.message;
    }
  }
  if (error instanceof Error) return error.message;
  return "";
}

// ── Approval payload rebuild ────────────────────────────────────────

export interface PendingApprovalInfo {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
}

/**
 * Strip stale approval payloads from the message input array and optionally
 * prepend fresh denial results for the actual pending approvals from the server.
 */
export function rebuildInputWithFreshDenials(
  currentInput: Array<MessageCreate | ApprovalCreate>,
  serverApprovals: PendingApprovalInfo[],
  denialReason: string,
): Array<MessageCreate | ApprovalCreate> {
  const stripped = currentInput.filter((item) => item?.type !== "approval");

  if (serverApprovals.length > 0) {
    const denials: ApprovalCreate = {
      type: "approval",
      approvals: serverApprovals.map((a) => ({
        type: "approval" as const,
        tool_call_id: a.toolCallId,
        approve: false,
        reason: denialReason,
      })),
    };
    return [denials, ...stripped];
  }

  return stripped;
}

// ── Retry gating ────────────────────────────────────────────────────

/**
 * Decide whether an approval-pending recovery attempt should proceed.
 * Centralizes the retry-budget check used by both TUI and headless.
 */
export function shouldAttemptApprovalRecovery(opts: {
  approvalPendingDetected: boolean;
  retries: number;
  maxRetries: number;
}): boolean {
  return opts.approvalPendingDetected && opts.retries < opts.maxRetries;
}
