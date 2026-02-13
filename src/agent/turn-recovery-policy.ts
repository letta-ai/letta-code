/**
 * Pure, framework-agnostic policy helpers for turn-level recovery.
 *
 * Both TUI (App.tsx) and headless (headless.ts) consume these helpers
 * so that identical conflict inputs always produce the same recovery
 * action. No network calls, no React, no stream-json output.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";

// ── Error fragment constants ────────────────────────────────────────

const INVALID_TOOL_CALL_IDS_FRAGMENT = "invalid tool call ids";
const APPROVAL_PENDING_DETAIL_FRAGMENT = "waiting for approval";
const CONVERSATION_BUSY_DETAIL_FRAGMENT =
  "another request is currently being processed";

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

// ── Pre-stream conflict routing ─────────────────────────────────────

export type PreStreamConflictKind =
  | "approval_pending"
  | "conversation_busy"
  | null;

export type PreStreamErrorAction =
  | "resolve_approval_pending"
  | "retry_conversation_busy"
  | "rethrow";

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
