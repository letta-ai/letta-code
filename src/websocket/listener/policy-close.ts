const REGISTRATION_INVALIDATING_POLICY_CLOSE_REASONS = new Set([
  "environment not found",
  "connection not found",
  "listener pair is not current",
  "listener pair is no longer current",
  "listener attempt is stale",
]);

export interface TerminalPolicyCloseHandlers {
  onDisconnected: () => void;
  onError: (error: Error) => void;
  onNeedsReregister?: () => void;
}

function normalizePolicyCloseReason(reason: string): string {
  return reason.trim().replace(/\s+/g, " ").toLowerCase();
}

function shouldReregisterAfterPolicyClose(reason: string): boolean {
  return REGISTRATION_INVALIDATING_POLICY_CLOSE_REASONS.has(
    normalizePolicyCloseReason(reason),
  );
}

function formatTerminalPolicyCloseError(reason: string): Error {
  const reasonText = reason.trim() || "no reason provided";
  return new Error(
    `Listener WebSocket rejected by relay policy (1008: ${reasonText})`,
  );
}

export function handleTerminalPolicyClose(
  reason: string,
  handlers: TerminalPolicyCloseHandlers,
): void {
  if (shouldReregisterAfterPolicyClose(reason)) {
    handlers.onNeedsReregister?.() ?? handlers.onDisconnected();
    return;
  }

  handlers.onError(formatTerminalPolicyCloseError(reason));
}
