import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { getClient } from "./client";

// Error when approval tool call IDs don't match what server expects
// Format: "Invalid tool call IDs: Expected [...], got [...]"
// This is a specific subtype of desync - server HAS approvals but with different IDs
const INVALID_TOOL_CALL_IDS_FRAGMENT = "invalid tool call ids";

// Error when trying to SEND message but server has pending approval waiting.
// Use an approval-specific fragment to avoid matching conversation-busy errors,
// which may also include "cannot send a new message".
const APPROVAL_PENDING_DETAIL_FRAGMENT = "waiting for approval";

// Error when conversation is busy (another request is being processed)
// This is a 409 CONFLICT when trying to send while a run is active
const CONVERSATION_BUSY_DETAIL_FRAGMENT =
  "another request is currently being processed";

type RunErrorMetadata =
  | {
      error_type?: string;
      message?: string;
      detail?: string;
      error?: { error_type?: string; message?: string; detail?: string };
    }
  | undefined
  | null;

/**
 * Check if error specifically indicates tool call ID mismatch.
 * This is a subtype of desync where the server HAS pending approvals,
 * but they have different IDs than what the client sent.
 *
 * Unlike "no tool call is currently awaiting approval" (server has nothing),
 * this error means we need to FETCH the actual pending approvals to resync.
 *
 * Error format:
 * { detail: "Invalid tool call IDs: Expected ['tc_abc'], got ['tc_xyz']" }
 */
export function isInvalidToolCallIdsError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(INVALID_TOOL_CALL_IDS_FRAGMENT);
}

/**
 * Check if error indicates there's a pending approval blocking new messages.
 * This is the CONFLICT error from the backend when trying to send a user message
 * while the agent is waiting for approval on a tool call.
 *
 * Error format:
 * { detail: "CONFLICT: Cannot send a new message: The agent is waiting for approval..." }
 */
export function isApprovalPendingError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(APPROVAL_PENDING_DETAIL_FRAGMENT);
}

/**
 * Check if error indicates the conversation is busy (another request is being processed).
 * This is a 409 CONFLICT when trying to send a message while a run is still active.
 *
 * Error format:
 * { detail: "CONFLICT: Cannot send a new message: Another request is currently being processed..." }
 */
export function isConversationBusyError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(CONVERSATION_BUSY_DETAIL_FRAGMENT);
}

export type PreStreamConflictKind =
  | "approval_pending"
  | "conversation_busy"
  | null;

export type PreStreamErrorAction =
  | "resolve_approval_pending"
  | "retry_conversation_busy"
  | "rethrow";

/**
 * Classify pre-stream 409 conflict details so callers can route recovery logic.
 */
export function classifyPreStreamConflict(
  detail: unknown,
): PreStreamConflictKind {
  if (isApprovalPendingError(detail)) return "approval_pending";
  if (isConversationBusyError(detail)) return "conversation_busy";
  return null;
}

/**
 * Determine pre-stream recovery action for one-shot headless sends.
 */
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

interface PendingApprovalInfo {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
}

/**
 * Strip stale approval payloads from the message input array and optionally
 * prepend fresh denial results for the actual pending approvals from the server.
 *
 * Used during approval-conflict recovery: the original payload may contain
 * queued approvals from an interrupt that the backend already rejected. This
 * replaces them with denials for the real pending approvals.
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
