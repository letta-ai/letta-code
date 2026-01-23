import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "./client";
import { APPROVAL_RECOVERY_PROMPT } from "./promptAssets";

// Error when trying to SEND approval but server has no pending approval
const APPROVAL_RECOVERY_DETAIL_FRAGMENT =
  "no tool call is currently awaiting approval";

// Error when approval tool call IDs don't match what server expects
// Format: "Invalid tool call IDs: Expected [...], got [...]"
// This is a specific subtype of desync - server HAS approvals but with different IDs
const INVALID_TOOL_CALL_IDS_FRAGMENT = "invalid tool call ids";

// Error when trying to SEND message but server has pending approval waiting
// This is the CONFLICT error - opposite of desync
const APPROVAL_PENDING_DETAIL_FRAGMENT = "cannot send a new message";

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

export function isApprovalStateDesyncError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const lower = detail.toLowerCase();
  return (
    lower.includes(APPROVAL_RECOVERY_DETAIL_FRAGMENT) ||
    lower.includes(INVALID_TOOL_CALL_IDS_FRAGMENT)
  );
}

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

export function buildApprovalRecoveryMessage(): MessageCreate {
  return {
    type: "message",
    role: "user",
    content: [{ type: "text", text: APPROVAL_RECOVERY_PROMPT }],
  };
}
