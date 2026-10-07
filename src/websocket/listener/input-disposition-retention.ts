import type { AcceptedInputDispositionEntry } from "./types";

function hasLegacyAuthorityFence(
  entry: AcceptedInputDispositionEntry,
): boolean {
  const authority = entry.completedTerminalAuthority;
  return Boolean(
    authority?.recoveryLineageId &&
      (!authority.terminalIdentity ||
        authority.preparationSequence === undefined),
  );
}

export function shouldRetainDisposition(
  entry: AcceptedInputDispositionEntry,
): boolean {
  return Boolean(
    entry.queuedInput ||
      entry.preparedTerminal ||
      hasLegacyAuthorityFence(entry),
  );
}
