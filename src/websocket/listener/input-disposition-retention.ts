import type { AcceptedInputDispositionEntry } from "./types";

export const PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY =
  Number.MAX_SAFE_INTEGER;

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
    if (!prepared || entry.legacyAuthorityQuarantine) continue;
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

export function buildLegacyAuthorityQuarantineIndex(
  entries: Iterable<AcceptedInputDispositionEntry>,
): ReadonlySet<string> {
  const references = new Set<string>();
  for (const entry of entries) {
    const quarantine = entry.legacyAuthorityQuarantine;
    if (!quarantine) continue;
    references.add(
      legacyAuthorityReferenceKey(
        entry.runtimeKey,
        quarantine.recoveryLineageId,
        quarantine.interruptedRevision,
      ),
    );
  }
  return references;
}

function buildExpiredLegacyAuthorityQuarantineIndex(
  entries: Iterable<AcceptedInputDispositionEntry>,
  now: number,
): ReadonlySet<string> {
  const references = new Set<string>();
  for (const entry of entries) {
    const quarantine = entry.legacyAuthorityQuarantine;
    if (!quarantine || entry.expiresAt > now || quarantine.expiresAt > now) {
      continue;
    }
    references.add(
      legacyAuthorityReferenceKey(
        entry.runtimeKey,
        quarantine.recoveryLineageId,
        quarantine.interruptedRevision,
      ),
    );
  }
  return references;
}

export function preparedTerminalMatchesLegacyAuthorityIndex(
  entry: AcceptedInputDispositionEntry,
  references: ReadonlySet<string>,
): boolean {
  const prepared = entry.preparedTerminal;
  const interruptedRevision = prepared?.owner.interruptedRevision;
  return Boolean(
    prepared &&
      interruptedRevision &&
      references.has(
        legacyAuthorityReferenceKey(
          entry.runtimeKey,
          prepared.owner.recoveryLineageId,
          interruptedRevision,
        ),
      ),
  );
}

export function settleExpiredQuarantineJournals(
  entries: Iterable<[string, AcceptedInputDispositionEntry]>,
  now: number,
  discard: (key: string, entry: AcceptedInputDispositionEntry) => void,
): boolean {
  const snapshot = [...entries];
  const references = buildExpiredLegacyAuthorityQuarantineIndex(
    snapshot.map(([, entry]) => entry),
    now,
  );
  const blocked = new Set(references);
  for (const [, entry] of snapshot) {
    const quarantine = entry.legacyAuthorityQuarantine;
    if (
      quarantine?.expiresAt !== PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY
    ) {
      continue;
    }
    blocked.add(
      legacyAuthorityReferenceKey(
        entry.runtimeKey,
        quarantine.recoveryLineageId,
        quarantine.interruptedRevision,
      ),
    );
  }
  const canonical = new Map<string, string>();
  for (const [key, entry] of snapshot) {
    const quarantine = entry.legacyAuthorityQuarantine;
    if (!quarantine) continue;
    const reference = legacyAuthorityReferenceKey(
      entry.runtimeKey,
      quarantine.recoveryLineageId,
      quarantine.interruptedRevision,
    );
    if (!references.has(reference)) continue;
    if (
      !canonical.has(reference) ||
      quarantine.expiresAt === PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY
    ) {
      canonical.set(reference, key);
    }
  }
  let changed = false;
  for (const [key, entry] of snapshot) {
    const quarantine = entry.legacyAuthorityQuarantine;
    if (quarantine) {
      const reference = legacyAuthorityReferenceKey(
        entry.runtimeKey,
        quarantine.recoveryLineageId,
        quarantine.interruptedRevision,
      );
      if (!references.has(reference)) continue;
      if (canonical.get(reference) === key) {
        quarantine.expiresAt = PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY;
        entry.expiresAt = PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY;
        entry.completedTerminalAuthority = undefined;
      } else {
        discard(key, entry);
      }
      changed = true;
    } else if (preparedTerminalMatchesLegacyAuthorityIndex(entry, blocked)) {
      discard(key, entry);
      changed = true;
    }
  }
  return changed;
}

export function isLegacyAuthorityQuarantine(
  entry: AcceptedInputDispositionEntry,
): boolean {
  return entry.legacyAuthorityQuarantine !== undefined;
}

export function shouldRetainDisposition(
  entry: AcceptedInputDispositionEntry,
  references: () => ReadonlySet<string>,
): boolean {
  if (entry.legacyAuthorityQuarantine) return false;
  if (entry.queuedInput || entry.preparedTerminal) return true;
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
