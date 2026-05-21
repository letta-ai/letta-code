const RAW_LOOP_ERROR_PATTERN = /^Unexpected stop reason:\s*error$/i;
const APPROVAL_PENDING_ERROR_PATTERNS = [
  /waiting for approval/i,
  /pending request before continuing/i,
  /approve or deny the pending request/i,
];

export const CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE =
  "Something went wrong while processing that message. Please try again.";

export const CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE =
  "The agent is still waiting on a tool approval from an earlier turn. Please approve or deny that pending request, then send your message again.";

export function normalizeChannelLifecycleErrorMessage(
  errorText: string | null | undefined,
): string {
  const normalized = errorText?.trim();
  if (!normalized || RAW_LOOP_ERROR_PATTERN.test(normalized)) {
    return CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE;
  }
  if (
    APPROVAL_PENDING_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE;
  }
  return normalized;
}
