import { expect, test } from "bun:test";
import {
  getOrCreateScopedRuntime,
  promotePreparedInputTerminals,
} from "./conversation-runtime";
import {
  ordinaryInputIdentity,
  rememberInputDisposition,
} from "./input-disposition";
import { seedLegacyAuthorityQuarantine } from "./input-disposition.test-helpers";
import { rebuildDispositionExpiryQueue } from "./input-disposition-capacity";
import {
  loadLegacyAuthorityQuarantines,
  prepareInputTerminal,
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
