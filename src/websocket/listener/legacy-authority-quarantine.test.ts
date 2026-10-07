import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  rebuildDispositionCapacityCounts,
  rebuildDispositionExpiryQueue,
} from "./input-disposition-capacity";
import {
  PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY,
  shouldRetainDisposition,
} from "./input-disposition-retention";
import { legacyAuthorityQuarantineEntryIsValid } from "./input-disposition-validation";
import {
  claimPreparedInputTerminalIfCurrent,
  hasCompetingCompletedPublicationClaim,
  loadCompletedTerminalAuthorities,
  loadLegacyAuthorityQuarantines,
  loadPreparedInputTerminals,
  prepareInputTerminal,
  publishPreparedInputTerminalIfCurrent,
  quarantinePreparedTerminalAuthority,
} from "./input-terminal-journal";
import { createRuntime, stopRuntime } from "./lifecycle";
import { createTurnFinishedStore } from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";
import type { AcceptedInputDispositionEntry } from "./types";

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

test("volatile legacy quarantine settles without rescheduling", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, runtime);
  expireQuarantine(listener);
  expect(loadLegacyAuthorityQuarantines(listener)).toEqual([
    expect.objectContaining({
      expiresAt: PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY,
    }),
  ]);
  expect(listener.acceptedInputDispositionLedger.quarantinedCount).toBe(1);
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

test("quarantine expiry permanently fences matching predecessor journals", () => {
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
    const referenceKey = Object.keys(store.entries)[1];
    const quarantinedEntry = entries[0];
    const referenceEntry = entries[1];
    const quarantine = quarantinedEntry?.legacyAuthorityQuarantine as {
      expiresAt: number;
    };
    if (
      !quarantinedEntry ||
      !referenceEntry ||
      !quarantine ||
      !referenceKey ||
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

    const volatile = createRuntime();
    volatile.acceptedInputDispositionLedger.entries = new Map(
      Object.entries(structuredClone(store.entries)) as [
        string,
        AcceptedInputDispositionEntry,
      ][],
    );
    volatile.acceptedInputDispositionLedger.nextGeneration =
      store.nextGeneration;
    rebuildDispositionCapacityCounts(volatile.acceptedInputDispositionLedger);
    rebuildDispositionExpiryQueue(volatile.acceptedInputDispositionLedger);
    expect(promotePreparedInputTerminals(volatile)).toBe(0);
    expect(loadLegacyAuthorityQuarantines(volatile)).toEqual([
      expect.objectContaining({
        expiresAt: PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY,
      }),
    ]);
    expect(loadPreparedInputTerminals(volatile)).toHaveLength(0);
    volatile.acceptedInputDispositionLedger.entries.set(
      referenceKey,
      structuredClone(
        referenceEntry,
      ) as unknown as AcceptedInputDispositionEntry,
    );
    rebuildDispositionCapacityCounts(volatile.acceptedInputDispositionLedger);
    rebuildDispositionExpiryQueue(volatile.acceptedInputDispositionLedger);
    expect(promotePreparedInputTerminals(volatile)).toBe(0);
    expect(loadPreparedInputTerminals(volatile)).toHaveLength(0);
    expect(volatile.acceptedInputDispositionLedger.entries.size).toBe(1);

    writeFileSync(ledgerPath, JSON.stringify(store), "utf8");

    const restarted = createRuntime();
    restarted.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: ledgerPath });
    expect(promotePreparedInputTerminals(restarted)).toBe(0);
    expect(loadLegacyAuthorityQuarantines(restarted)).toHaveLength(1);
    expect(loadPreparedInputTerminals(restarted)).toHaveLength(0);
    const settledStore = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      entries: Record<string, Record<string, unknown>>;
    };
    settledStore.entries[referenceKey] = structuredClone(referenceEntry);
    writeFileSync(ledgerPath, JSON.stringify(settledStore), "utf8");
    const reread = createRuntime();
    reread.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: ledgerPath });
    expect(promotePreparedInputTerminals(reread)).toBe(0);
    expect(loadPreparedInputTerminals(reread)).toHaveLength(0);
    expect(loadLegacyAuthorityQuarantines(reread)).toHaveLength(1);
    const finalStore = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(finalStore.entries)).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("promotion revalidates after expiry wins a detached journal race", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  const identity = ordinaryInputIdentity("detached-promotion-race");
  if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
    throw new Error("failed to seed detached promotion race");
  }
  const interruptedRevision = "revision-detached-race";
  const recoveryLineageId = "lineage-detached-race";
  const authorityRevision = "authority-detached-race";
  expect(
    prepareInputTerminal(runtime, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-0" },
      message: {
        type: "turn_finished",
        turn_id: "turn-detached-race",
        stop_reason: "end_turn",
        terminal_consumer_ids: ["consumer-detached-race"],
      },
      owner: {
        connectionId: "connection-detached-race",
        canRotate: false,
        lineageId: "listener-detached-race",
        terminalIdentity: "terminal-detached-race",
        interruptedRevision,
        recoveryLineageId,
        interruptedAuthorityRevision: authorityRevision,
      },
    }),
  ).toBe(true);
  let putCalls = 0;
  const terminalStore = {
    read: () => null,
    readOrThrow: () => null,
    put: () => {
      putCalls += 1;
    },
  };
  const interruptedStore = {
    readRecoverySnapshot: () => ({
      record: { revision: interruptedRevision },
      revisionToken: authorityRevision,
    }),
    readRetiredRecoveryAuthority: () => null,
  };
  let raced = false;
  const raceLoader = () => {
    const detached = loadPreparedInputTerminals(listener);
    if (raced) return detached;
    raced = true;
    expect(
      quarantinePreparedTerminalAuthority(
        listener,
        { agentId: "agent-0", conversationId: "conversation-0" },
        {
          interruptedRevision,
          recoveryLineageId,
          authorityRevision: "legacy-detached-race",
        },
      ),
    ).toBe(true);
    expireQuarantine(listener);
    expect(loadLegacyAuthorityQuarantines(listener)).toHaveLength(1);
    return detached;
  };
  expect(
    promotePreparedInputTerminals(
      listener,
      terminalStore as never,
      undefined,
      interruptedStore as never,
      undefined,
      undefined,
      raceLoader,
    ),
  ).toBe(0);
  expect(putCalls).toBe(0);
});

test("publication claim survives put-then-throw and outranks quarantine", () => {
  const directory = mkdtempSync(join(tmpdir(), "publication-claim-race-"));
  const ledgerPath = join(directory, "dispositions.json");
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  const identity = ordinaryInputIdentity("publication-claim-race");
  if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
    throw new Error("failed to seed publication claim race");
  }
  const interruptedRevision = "revision-publication-claim";
  const recoveryLineageId = "lineage-publication-claim";
  const authorityRevision = "authority-publication-claim";
  expect(
    prepareInputTerminal(runtime, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-0" },
      message: {
        type: "turn_finished",
        turn_id: "turn-publication-claim",
        stop_reason: "end_turn",
        terminal_consumer_ids: ["consumer-publication-claim"],
      },
      owner: {
        connectionId: "connection-publication-claim",
        canRotate: false,
        lineageId: "listener-publication-claim",
        terminalIdentity: "terminal-publication-claim",
        interruptedRevision,
        recoveryLineageId,
        interruptedAuthorityRevision: authorityRevision,
      },
    }),
  ).toBe(true);
  let putCalls = 0;
  let throwAfterPut = true;
  const terminalStore = {
    read: () => null,
    readOrThrow: () => null,
    put: () => {
      putCalls += 1;
      if (throwAfterPut) {
        throwAfterPut = false;
        throw new Error("put committed then transport failed");
      }
    },
  };
  let currentAuthorityRevision = authorityRevision;
  const interruptedStore = {
    readRecoverySnapshot: () => ({
      record: { revision: interruptedRevision },
      revisionToken: currentAuthorityRevision,
    }),
    readRetiredRecoveryAuthority: () => null,
  };
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      version: 4,
      nextGeneration: listener.acceptedInputDispositionLedger.nextGeneration,
      entries: Object.fromEntries(
        listener.acceptedInputDispositionLedger.entries,
      ),
      reservations: {},
    }),
    "utf8",
  );
  const durable = createRuntime();
  durable.acceptedInputDispositionLedger = createAcceptedInputDispositionLedger(
    { persistentPath: ledgerPath },
  );
  expect(
    promotePreparedInputTerminals(
      durable,
      terminalStore as never,
      undefined,
      interruptedStore as never,
    ),
  ).toBe(0);
  const restarted = createRuntime();
  restarted.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: ledgerPath });
  expect(loadPreparedInputTerminals(restarted)[0]?.publicationClaimed).toBe(
    true,
  );
  currentAuthorityRevision = "newer-authority-after-publication-claim";
  const legacyAuthority = {
    interruptedRevision,
    recoveryLineageId,
    authorityRevision: "legacy-publication-claim",
  };
  expect(
    quarantinePreparedTerminalAuthority(
      restarted,
      { agentId: "agent-0", conversationId: "conversation-0" },
      legacyAuthority,
    ),
  ).toBe(false);
  expect(
    promotePreparedInputTerminals(
      restarted,
      terminalStore as never,
      undefined,
      interruptedStore as never,
    ),
  ).toBe(1);
  expect(
    quarantinePreparedTerminalAuthority(
      restarted,
      { agentId: "agent-0", conversationId: "conversation-0" },
      legacyAuthority,
    ),
  ).toBe(false);
  expect(putCalls).toBe(2);
  expect(loadPreparedInputTerminals(restarted)).toHaveLength(0);
  expect(loadLegacyAuthorityQuarantines(restarted)).toHaveLength(0);
  rmSync(directory, { recursive: true, force: true });
});

test("publication claim rejects completed authority added after validation", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  const identity = ordinaryInputIdentity("authority-cas-race");
  if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
    throw new Error("failed to seed authority CAS race");
  }
  const interruptedRevision = "revision-authority-cas";
  const recoveryLineageId = "lineage-authority-cas";
  const authorityRevision = "authority-cas";
  expect(
    prepareInputTerminal(runtime, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-0" },
      message: {
        type: "turn_finished",
        turn_id: "turn-authority-cas",
        stop_reason: "end_turn",
        terminal_consumer_ids: ["consumer-authority-cas"],
      },
      owner: {
        connectionId: "connection-authority-cas",
        canRotate: false,
        lineageId: "listener-authority-cas",
        terminalIdentity: "terminal-authority-cas",
        interruptedRevision,
        recoveryLineageId,
        interruptedAuthorityRevision: authorityRevision,
      },
    }),
  ).toBe(true);
  let insertedCompetingAuthority = false;
  let putCalls = 0;
  const terminalStore = {
    read: () => null,
    readOrThrow: () => {
      if (!insertedCompetingAuthority) {
        insertedCompetingAuthority = true;
        listener.acceptedInputDispositionLedger.entries.set(
          "competing-completed-authority",
          {
            disposition: "started",
            acceptedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            runtimeKey: runtime.key,
            generation: 99_001,
            replayCompleted: true,
            completedTerminalAuthority: {
              interruptedRevision,
              recoveryLineageId,
              authorityRevision: "competing-authority-cas",
              terminalIdentity: "terminal-competing-authority-cas",
              preparationSequence: 99_001,
            },
          },
        );
      }
      return null;
    },
    put: () => {
      putCalls += 1;
    },
  };
  const interruptedStore = {
    readRecoverySnapshot: () => ({
      record: { revision: interruptedRevision },
      revisionToken: authorityRevision,
    }),
    readRetiredRecoveryAuthority: () => null,
  };
  expect(
    promotePreparedInputTerminals(
      listener,
      terminalStore as never,
      undefined,
      interruptedStore as never,
    ),
  ).toBe(0);
  expect(putCalls).toBe(0);
  expect(loadPreparedInputTerminals(listener)[0]?.publicationClaimed).toBe(
    undefined,
  );
});

test("publication claim rejects recovery authority rotation at its lock", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  const identity = ordinaryInputIdentity("authority-lock-race");
  if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
    throw new Error("failed to seed authority lock race");
  }
  expect(
    prepareInputTerminal(runtime, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-0" },
      message: {
        type: "turn_finished",
        turn_id: "turn-authority-lock",
        stop_reason: "end_turn",
      },
      owner: {
        connectionId: "connection-authority-lock",
        canRotate: false,
        lineageId: "listener-authority-lock",
        terminalIdentity: "terminal-authority-lock",
        interruptedRevision: "revision-authority-lock",
        recoveryLineageId: "lineage-authority-lock",
        interruptedAuthorityRevision: "authority-lock-before-rotation",
      },
    }),
  ).toBe(true);
  const prepared = loadPreparedInputTerminals(listener)[0];
  if (!prepared) throw new Error("missing authority lock journal");
  let actions = 0;
  expect(
    claimPreparedInputTerminalIfCurrent(listener, prepared, [], {
      withRecoveryAuthority: ({ expectedRevision }) => {
        expect(expectedRevision).toBe("authority-lock-before-rotation");
        actions += 1;
        return false;
      },
    }),
  ).toBe(false);
  expect(actions).toBe(1);
  expect(loadPreparedInputTerminals(listener)[0]?.publicationClaimed).toBe(
    undefined,
  );
});

test("one publication claim fences a later competing journal", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  const interruptedRevision = "revision-competing-claim";
  const recoveryLineageId = "lineage-competing-claim";
  const prepare = (id: string) => {
    const identity = ordinaryInputIdentity(`input-${id}`);
    if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
      throw new Error(`failed to seed ${id}`);
    }
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-0", conversationId: "conversation-0" },
        message: {
          type: "turn_finished",
          turn_id: `turn-${id}`,
          stop_reason: "end_turn",
          terminal_consumer_ids: [`consumer-${id}`],
        },
        owner: {
          connectionId: `connection-${id}`,
          canRotate: false,
          lineageId: `listener-${id}`,
          terminalIdentity: `terminal-${id}`,
          interruptedRevision,
          recoveryLineageId,
          interruptedAuthorityRevision: `authority-${id}`,
        },
      }),
    ).toBe(true);
  };
  prepare("first-claim");
  const first = loadPreparedInputTerminals(listener)[0];
  if (!first) throw new Error("missing first publication journal");
  expect(claimPreparedInputTerminalIfCurrent(listener, first)).toBe(true);
  const laterIdentity = ordinaryInputIdentity("input-later-claim");
  if (
    !laterIdentity ||
    !rememberInputDisposition(runtime, laterIdentity, "started")
  ) {
    throw new Error("failed to seed later claim");
  }
  const laterTerminal = {
    scope: { agentId: "agent-0", conversationId: "conversation-0" },
    message: {
      type: "turn_finished" as const,
      turn_id: "turn-later-claim",
      stop_reason: "end_turn" as const,
      terminal_consumer_ids: ["consumer-later-claim"],
    },
    owner: {
      connectionId: "connection-later-claim",
      canRotate: false,
      lineageId: "listener-later-claim",
      terminalIdentity: "terminal-later-claim",
      interruptedRevision,
      recoveryLineageId,
      interruptedAuthorityRevision: "authority-later-claim",
    },
  };
  expect(prepareInputTerminal(runtime, [laterIdentity], laterTerminal)).toBe(
    true,
  );
  const laterEntry = [
    ...listener.acceptedInputDispositionLedger.entries.values(),
  ].find(
    (entry) => entry.preparedTerminal?.message.turn_id === "turn-later-claim",
  );
  if (!laterEntry) throw new Error("missing later claim entry");
  const later = loadPreparedInputTerminals(listener).find(
    (prepared) => prepared.message.turn_id === "turn-later-claim",
  );
  if (!later) throw new Error("missing later publication journal");
  expect(() => claimPreparedInputTerminalIfCurrent(listener, later)).toThrow(
    "Competing terminal already owns publication claim",
  );
  expect(
    quarantinePreparedTerminalAuthority(
      listener,
      { agentId: "agent-0", conversationId: "conversation-0" },
      {
        interruptedRevision,
        recoveryLineageId,
        authorityRevision: "legacy-competing-claim",
      },
    ),
  ).toBe(false);
  expect(publishPreparedInputTerminalIfCurrent(listener, first, () => {})).toBe(
    true,
  );
  expect(loadPreparedInputTerminals(listener)).toHaveLength(0);
  expect(
    hasCompetingCompletedPublicationClaim(
      later,
      loadCompletedTerminalAuthorities(listener),
    ),
  ).toBe(true);
  laterEntry.preparedTerminal = structuredClone(later);
  let latePutCalls = 0;
  expect(
    promotePreparedInputTerminals(
      listener,
      {
        read: () => null,
        readOrThrow: () => null,
        remove: () => true,
        put: () => {
          latePutCalls += 1;
        },
      } as never,
      undefined,
      {
        readRecoverySnapshot: () => ({
          record: { revision: interruptedRevision },
          revisionToken: "authority-later-claim",
        }),
        readRetiredRecoveryAuthority: () => null,
      } as never,
    ),
  ).toBe(0);
  expect(latePutCalls).toBe(0);
  expect(loadPreparedInputTerminals(listener)).toHaveLength(0);
});

test("non-consumer promotion still defers when journal clearing fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "non-consumer-clear-"));
  try {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const identity = ordinaryInputIdentity("non-consumer-clear-failure");
    if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
      throw new Error("failed to seed non-consumer clear failure");
    }
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message: {
          type: "turn_finished",
          turn_id: "turn-non-consumer-clear-failure",
          stop_reason: "end_turn",
        },
        owner: {
          connectionId: null,
          canRotate: false,
          lineageId: null,
          terminalIdentity: "terminal-non-consumer-clear-failure",
        },
      }),
    ).toBe(true);
    const terminalStore = createTurnFinishedStore(join(directory, "terminal"));
    expect(
      promotePreparedInputTerminals(
        listener,
        terminalStore,
        undefined,
        undefined,
        undefined,
        () => false,
      ),
    ).toBe(0);
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
    expect(promotePreparedInputTerminals(listener, terminalStore)).toBe(1);
    expect(loadPreparedInputTerminals(listener)).toHaveLength(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("crash-proof non-consumer journal persists before atomic retirement", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const identity = ordinaryInputIdentity("non-consumer-crash-proof");
  if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
    throw new Error("failed to seed crash-proof non-consumer journal");
  }
  expect(
    prepareInputTerminal(runtime, [identity], {
      persistWithoutConsumers: true,
      scope: { agentId: "agent-1", conversationId: "conv-1" },
      message: {
        type: "turn_finished",
        turn_id: "turn-non-consumer-crash-proof",
        stop_reason: "end_turn",
      },
      owner: {
        connectionId: null,
        canRotate: true,
        lineageId: null,
        terminalIdentity: "terminal-non-consumer-crash-proof",
      },
    }),
  ).toBe(true);
  let putCalls = 0;
  let failPut = true;
  const terminalStore = {
    read: () => null,
    readOrThrow: () => null,
    put: () => {
      putCalls += 1;
      if (failPut) throw new Error("non-consumer put failed");
    },
  };
  expect(promotePreparedInputTerminals(listener, terminalStore as never)).toBe(
    0,
  );
  expect(loadPreparedInputTerminals(listener)).toEqual([
    expect.objectContaining({
      persistWithoutConsumers: true,
      publicationClaimed: true,
    }),
  ]);
  failPut = false;
  expect(promotePreparedInputTerminals(listener, terminalStore as never)).toBe(
    1,
  );
  expect(putCalls).toBe(2);
  expect(loadPreparedInputTerminals(listener)).toHaveLength(0);
});

test("live non-consumer crash proof claims before terminal persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "live-non-consumer-"));
  try {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const identity = ordinaryInputIdentity("live-non-consumer-crash-proof");
    if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
      throw new Error("failed to seed live crash-proof journal");
    }
    const lease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    const terminalStore = createTurnFinishedStore(directory);
    const transition = finishListenerTurn(runtime, lease, {
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      turnId: "turn-live-non-consumer-crash-proof",
      stopReason: "end_turn",
      agentId: runtime.agentId,
      conversationId: runtime.conversationId,
      durableInputIdentities: [identity],
      persistTerminalWithoutConsumers: true,
      turnFinishedStore: terminalStore,
    });
    expect(transition.finished).toBe(true);
    expect(loadPreparedInputTerminals(listener)).toHaveLength(0);
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);
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
