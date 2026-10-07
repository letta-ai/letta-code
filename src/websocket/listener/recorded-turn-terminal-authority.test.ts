import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  promotePreparedInputTerminals,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import {
  completePreparedInputTerminal,
  loadPreparedInputTerminals,
  prepareInputTerminal,
} from "./input-terminal-journal";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { hasRecordedTerminalEvidence } from "./recorded-turn-terminal";
import {
  markRecoveryClaimCompletionPending,
  retireAcknowledgedRecoveryClaim,
} from "./recovery-claim-completion";
import { createTurnFinishedStore } from "./turn-finished-replay";

test("terminal evidence is bound to the exact sidecar authority token", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-authority-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(directory);
  const identity = ordinaryInputIdentity("cm-authority");
  if (!identity) throw new Error("missing input identity");
  try {
    const reservation = reserveInputDisposition(runtime, identity);
    if (reservation.kind !== "reserved")
      throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, reservation.reservation, "started", {
        incoming: {
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [
            { role: "user", content: "run", client_message_id: "cm-authority" },
          ],
        },
      }),
    ).toBe(true);
    const owner = {
      connectionId: null,
      canRotate: false,
      lineageId: null,
      terminalIdentity: "terminal-authority",
      interruptedRevision: "revision-predecessor",
      recoveryLineageId: "lineage-predecessor",
      interruptedAuthorityRevision: "token-1",
    };
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message: {
          type: "turn_finished",
          turn_id: "turn-authority",
          stop_reason: "end_turn",
        },
        owner,
      }),
    ).toBe(true);
    expect(
      completePreparedInputTerminal(runtime, [identity], "turn-authority"),
    ).toBe(true);

    const evidence = (authorityRevision: string) =>
      hasRecordedTerminalEvidence(listener, terminalStore, {
        agentId: "agent-1",
        conversationId: "conv-1",
        runtimeKey: runtime.key,
        identities: [identity],
        revision: "revision-predecessor",
        recoveryLineageId: "lineage-predecessor",
        authorityRevision,
      });
    expect(evidence("token-1")).toBe(true);
    expect(evidence("token-2")).toBe(false);

    terminalStore.put(
      "agent-1",
      "conv-1",
      {
        type: "turn_finished",
        turn_id: "turn-authority-store",
        stop_reason: "end_turn",
      },
      { ...owner, terminalIdentity: "terminal-authority-store" },
    );
    expect(evidence("token-1")).toBe(true);
    expect(evidence("token-2")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retired sidecar preserves a persisted unacknowledged prepared terminal", () => {
  const directory = mkdtempSync(join(tmpdir(), "retired-terminal-authority-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const interruptedStore = createInterruptedTurnStore(
    join(directory, "interrupted"),
  );
  const identity = ordinaryInputIdentity("cm-retired-authority");
  if (!identity) throw new Error("missing input identity");
  try {
    const reservation = reserveInputDisposition(runtime, identity);
    if (reservation.kind !== "reserved")
      throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, reservation.reservation, "started"),
    ).toBe(true);
    const predecessor = interruptedStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: directory,
      durableInputIdentities: [identity],
      recoveryClaimCompletion: {
        lineageId: "lineage-predecessor",
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    interruptedStore.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          lineageId: "lineage-predecessor",
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectRunId: predecessor.runId,
          effectToolCallIds: predecessor.toolCallIds,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
          effectInputIdentities: [identity],
        },
      },
      predecessor.revision,
    );
    const snapshot = interruptedStore.readRecoverySnapshot(
      "agent-1",
      "conv-1",
      "lineage-predecessor",
    );
    if (!snapshot) throw new Error("missing sidecar authority");
    const owner = {
      connectionId: null,
      canRotate: false,
      lineageId: null,
      terminalIdentity: "terminal-retired-authority",
      interruptedRevision: predecessor.revision,
      recoveryLineageId: "lineage-predecessor",
      interruptedAuthorityRevision: snapshot.revisionToken,
    };
    const message = {
      type: "turn_finished" as const,
      turn_id: "turn-retired-authority",
      stop_reason: "end_turn" as const,
    };
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message,
        owner,
      }),
    ).toBe(true);
    terminalStore.put("agent-1", "conv-1", message, owner);
    const pending = markRecoveryClaimCompletionPending(
      interruptedStore,
      snapshot.record,
      snapshot.revisionToken,
    );
    if (!pending?.revision) throw new Error("missing pending revision");
    expect(
      retireAcknowledgedRecoveryClaim(interruptedStore, {
        agentId: "agent-1",
        conversationId: "conv-1",
        lineageId: "lineage-predecessor",
        pendingRevision: pending.revision,
      }),
    ).toBe("preserved");
    expect(
      interruptedStore.readRecoverySnapshot(
        "agent-1",
        "conv-1",
        "lineage-predecessor",
      ),
    ).toBeNull();

    expect(
      promotePreparedInputTerminals(
        listener,
        terminalStore,
        undefined,
        interruptedStore,
      ),
    ).toBe(1);
    expect(loadPreparedInputTerminals(listener)).toEqual([]);
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
