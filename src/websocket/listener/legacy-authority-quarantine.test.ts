import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  promotePreparedInputTerminals,
} from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
  ordinaryInputIdentity,
  rememberInputDisposition,
} from "./input-disposition";
import { seedLegacyAuthorityQuarantine } from "./input-disposition.test-helpers";
import { rebuildDispositionExpiryQueue } from "./input-disposition-capacity";
import { shouldRetainDisposition } from "./input-disposition-retention";
import { legacyAuthorityQuarantineEntryIsValid } from "./input-disposition-validation";
import {
  loadLegacyAuthorityQuarantines,
  loadPreparedInputTerminals,
  prepareInputTerminal,
  quarantinePreparedTerminalAuthority,
} from "./input-terminal-journal";
import { createRuntime, stopRuntime } from "./lifecycle";

function expireQuarantine(listener: ReturnType<typeof createRuntime>): void {
  const entry = [
    ...listener.acceptedInputDispositionLedger.entries.values(),
  ].find((candidate) => candidate.legacyAuthorityQuarantine);
  if (!entry?.legacyAuthorityQuarantine)
    throw new Error("missing quarantine fixture");
  entry.expiresAt = Date.now() - 1;
  entry.legacyAuthorityQuarantine.expiresAt = entry.expiresAt;
  rebuildDispositionExpiryQueue(listener.acceptedInputDispositionLedger);
}

test("legacy authority quarantine is isolated by conversation scope", () => {
  const listener = createRuntime();
  const quarantined = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, quarantined);

  const other = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-other",
  );
  const identity = ordinaryInputIdentity("other-scope-input");
  if (!identity) throw new Error("missing other-scope identity");
  expect(rememberInputDisposition(other, identity, "started")).toBe(true);
  expect(
    prepareInputTerminal(other, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-other" },
      message: {
        type: "turn_finished",
        turn_id: "turn-other-scope",
        stop_reason: "end_turn",
      },
      owner: {
        connectionId: null,
        canRotate: false,
        lineageId: "lineage-other-scope",
        terminalIdentity: "terminal-other-scope",
        interruptedRevision: "revision-legacy-quarantine",
        recoveryLineageId: "recovery-legacy-quarantine",
        interruptedAuthorityRevision: "authority-other-scope",
      },
    }),
  ).toBe(true);
});

test("volatile legacy quarantine expires without rescheduling", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, runtime);
  expireQuarantine(listener);
  expect(loadLegacyAuthorityQuarantines(listener)).toHaveLength(0);
  expect(listener.acceptedInputDispositionLedger.quarantinedCount).toBe(0);
});

test("legacy quarantine rejects divergent expiry authorities", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, runtime);
  const entry = [
    ...listener.acceptedInputDispositionLedger.entries.values(),
  ].find((candidate) => candidate.legacyAuthorityQuarantine);
  if (!entry?.legacyAuthorityQuarantine)
    throw new Error("missing quarantine expiry fixture");
  entry.legacyAuthorityQuarantine.expiresAt += 1;
  expect(
    legacyAuthorityQuarantineEntryIsValid(
      entry as unknown as Record<string, unknown>,
      entry.runtimeKey,
    ),
  ).toBe(false);
});

test("legacy quarantine is never re-armed by predecessor references", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, runtime);
  const entry = [
    ...listener.acceptedInputDispositionLedger.entries.values(),
  ].find((candidate) => candidate.legacyAuthorityQuarantine);
  if (!entry?.legacyAuthorityQuarantine)
    throw new Error("missing quarantine retention fixture");
  const quarantine = entry.legacyAuthorityQuarantine;
  entry.completedTerminalAuthority = {
    recoveryLineageId: quarantine.recoveryLineageId,
    interruptedRevision: quarantine.interruptedRevision,
    authorityRevision: "legacy-authority",
  };
  const reference = JSON.stringify([
    entry.runtimeKey,
    quarantine.recoveryLineageId,
    quarantine.interruptedRevision,
  ]);
  expect(shouldRetainDisposition(entry, () => new Set([reference]))).toBe(
    false,
  );
});

test("durable quarantine expires beside a matching predecessor journal", () => {
  const directory = mkdtempSync(join(tmpdir(), "legacy-quarantine-retention-"));
  const ledgerPath = join(directory, "input-dispositions.json");
  try {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-0",
      "conversation-0",
    );
    const identities = [
      "legacy-quarantine-retained",
      "legacy-reference-retained",
    ].map((id) => {
      const identity = ordinaryInputIdentity(id);
      if (
        !identity ||
        !rememberInputDisposition(runtime, identity, "started")
      ) {
        throw new Error("failed to seed durable retention identity");
      }
      return identity;
    });
    const interruptedRevision = "revision-retention";
    const recoveryLineageId = "lineage-retention";
    expect(
      prepareInputTerminal(runtime, identities, {
        scope: { agentId: "agent-0", conversationId: "conversation-0" },
        message: {
          type: "turn_finished",
          turn_id: "turn-retention",
          stop_reason: "end_turn",
        },
        owner: {
          connectionId: null,
          canRotate: false,
          lineageId: "listener-retention",
          terminalIdentity: "terminal-retention",
          interruptedRevision,
          recoveryLineageId,
          interruptedAuthorityRevision: "authority-retention",
        },
      }),
    ).toBe(true);
    const preparedEntries = [
      ...listener.acceptedInputDispositionLedger.entries.values(),
    ];
    const referencePrepared = structuredClone(
      preparedEntries[1]?.preparedTerminal,
    );
    expect(
      quarantinePreparedTerminalAuthority(
        listener,
        { agentId: "agent-0", conversationId: "conversation-0" },
        {
          interruptedRevision,
          recoveryLineageId,
          authorityRevision: "legacy-retention",
        },
      ),
    ).toBe(true);
    const store = {
      version: 4,
      nextGeneration: listener.acceptedInputDispositionLedger.nextGeneration,
      entries: Object.fromEntries(
        [...listener.acceptedInputDispositionLedger.entries].map(
          ([key, entry]) => [key, structuredClone(entry)],
        ),
      ) as Record<string, Record<string, unknown>>,
      reservations: {},
    };
    const entries = Object.values(store.entries);
    const quarantinedEntry = entries[0];
    const referenceEntry = entries[1];
    const quarantine = quarantinedEntry?.legacyAuthorityQuarantine as {
      expiresAt: number;
    };
    if (
      !quarantinedEntry ||
      !referenceEntry ||
      !quarantine ||
      !referencePrepared
    ) {
      throw new Error("missing durable quarantine retention fixture");
    }
    const expiredAt = Date.now() - 1;
    quarantinedEntry.expiresAt = expiredAt;
    quarantine.expiresAt = expiredAt;
    quarantinedEntry.completedTerminalAuthority = {
      interruptedRevision,
      recoveryLineageId,
      authorityRevision: "legacy-retention",
    };
    delete referenceEntry.legacyAuthorityQuarantine;
    referenceEntry.preparedTerminal = referencePrepared;
    writeFileSync(ledgerPath, JSON.stringify(store), "utf8");

    const restarted = createRuntime();
    restarted.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: ledgerPath });
    expect(loadLegacyAuthorityQuarantines(restarted)).toHaveLength(0);
    expect(loadPreparedInputTerminals(restarted)).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("listener stop clears legacy quarantine cleanup timers", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, runtime);
  const entry = [
    ...listener.acceptedInputDispositionLedger.entries.values(),
  ].find((candidate) => candidate.legacyAuthorityQuarantine);
  if (!entry?.legacyAuthorityQuarantine)
    throw new Error("missing quarantine timer fixture");
  entry.expiresAt = Date.now() + 25;
  entry.legacyAuthorityQuarantine.expiresAt = entry.expiresAt;
  let cleanupCalls = 0;
  listener.promotePreparedInputTerminals = () => {
    cleanupCalls += 1;
    return 0;
  };
  promotePreparedInputTerminals(listener);
  stopRuntime(listener, true);
  await Bun.sleep(50);
  expect(cleanupCalls).toBe(0);
});
