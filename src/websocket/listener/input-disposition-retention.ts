import type { AcceptedInputDispositionEntry } from "./types";

function legacyAuthorityReferenceKey(
  runtimeKey: string,
  recoveryLineageId: string | undefined,
  interruptedRevision: string,
): string {
  return JSON.stringify([
    runtimeKey,
    recoveryLineageId ?? null,
    interruptedRevision,
  ]);
}

export function buildLegacyAuthorityReferenceIndex(
  entries: Iterable<AcceptedInputDispositionEntry>,
): ReadonlySet<string> {
  const references = new Set<string>();
  for (const entry of entries) {
    const prepared = entry.preparedTerminal;
    if (!prepared || entry.legacyAuthorityQuarantined) continue;
    const revision = prepared.owner.interruptedRevision;
    if (!revision) continue;
    references.add(
      legacyAuthorityReferenceKey(
        entry.runtimeKey,
        prepared.owner.recoveryLineageId,
        revision,
      ),
    );
  }
  return references;
}

export function isLegacyAuthorityQuarantine(
  entry: AcceptedInputDispositionEntry,
): boolean {
  return entry.legacyAuthorityQuarantined === true;
}

export function shouldRetainDisposition(
  entry: AcceptedInputDispositionEntry,
  references: () => ReadonlySet<string>,
): boolean {
  if (
    entry.queuedInput ||
    entry.preparedTerminal ||
    entry.legacyAuthorityQuarantined
  )
    return true;
  const authority = entry.completedTerminalAuthority;
  if (
    !authority ||
    authority.terminalIdentity ||
    authority.preparationSequence !== undefined
  ) {
    return false;
  }
  return references().has(
    legacyAuthorityReferenceKey(
      entry.runtimeKey,
      authority.recoveryLineageId,
      authority.interruptedRevision,
    ),
  );
}
