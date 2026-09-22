const APPROVAL_PENDING_ERROR_PATTERNS = [
  /waiting for approval/i,
  /pending request before continuing/i,
  /approve or deny the pending request/i,
];

export const APPROVAL_PENDING_ERROR_MESSAGE =
  "The agent is still waiting on a tool approval from an earlier turn. Please approve or deny that pending request, then send your message again.";

export function isApprovalPendingErrorText(
  errorText: string | null | undefined,
): boolean {
  if (!errorText) return false;
  return APPROVAL_PENDING_ERROR_PATTERNS.some((pattern) =>
    pattern.test(errorText),
  );
}
