import { readFileSync, writeFileSync } from "node:fs";
import { createAcceptedInputDispositionLedger } from "./input-disposition";
import type { AcceptedInputDispositionEntry, ListenerRuntime } from "./types";

type ExpirableEntry = {
  expiresAt: number;
  legacyAuthorityQuarantine?: { expiresAt: number };
  completedTerminalAuthority?: {
    terminalIdentity?: string;
    preparationSequence?: number;
    publicationClaimed?: true;
  };
};

export function downgradeCompletedAuthority(entry: ExpirableEntry): void {
  const authority = entry.completedTerminalAuthority;
  if (!authority) throw new Error("missing completed authority fixture");
  delete authority.terminalIdentity;
  delete authority.preparationSequence;
  delete authority.publicationClaimed;
  entry.expiresAt = Date.now() - 1;
}

export function expireDispositionLedgerEntries(
  ledgerPath: string,
  legacyAuthoritiesOnly = false,
): void {
  const store = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
    entries: Record<string, ExpirableEntry>;
  };
  for (const entry of Object.values(store.entries)) {
    const authority = entry.completedTerminalAuthority;
    if (
      legacyAuthoritiesOnly &&
      (!authority ||
        authority.terminalIdentity ||
        authority.preparationSequence !== undefined)
    ) {
      continue;
    }
    const expiredAt = Date.now() - 1;
    entry.expiresAt = expiredAt;
    if (entry.legacyAuthorityQuarantine) {
      entry.legacyAuthorityQuarantine.expiresAt = expiredAt;
    }
  }
  writeFileSync(ledgerPath, JSON.stringify(store), "utf8");
}

export function setDispositionLedger(
  listener: ListenerRuntime,
  persistentPath: string | null,
): void {
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath });
}

export function snapshotDispositionStore(listener: ListenerRuntime): {
  version: 4;
  nextGeneration: number;
  entries: Record<string, AcceptedInputDispositionEntry>;
  reservations: Record<string, never>;
} {
  return {
    version: 4,
    nextGeneration: listener.acceptedInputDispositionLedger.nextGeneration,
    entries: Object.fromEntries(
      [...listener.acceptedInputDispositionLedger.entries].map(
        ([key, entry]) => [key, structuredClone(entry)],
      ),
    ),
    reservations: {},
  };
}
