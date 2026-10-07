import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
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
  clearPreparedInputTerminal,
  completePreparedInputTerminal,
  discardPreparedInputTerminal,
  loadPreparedInputTerminals,
  prepareInputTerminal,
} from "./input-terminal-journal";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import {
  hasRecordedTerminalEvidence,
  prepareRecordedInputTerminal,
} from "./recorded-turn-terminal";
import {
  markRecoveryClaimCompletionPending,
  retireAcknowledgedRecoveryClaim,
} from "./recovery-claim-completion";
import type { ListenerTransport } from "./transport";
import { createTurnFinishedStore } from "./turn-finished-replay";

function installTerminalOwner(
  listener: ReturnType<typeof createRuntime>,
  connectionId: string,
): void {
  const transport: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  const connection = openListenerConnection({
    runtime: listener,
    connectionId,
    writer: transport,
    options: {
      connectionId,
      wsUrl: "local://test",
      deviceId: connectionId,
      connectionName: connectionId,
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
  });
  subscribeListenerConnection(listener, connection.id, {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
  markListenerConnectionInitialized(listener, connection.id, connection);
  getOrCreateScopedRuntime(listener, "agent-1", "conv-1").activeConnectionId =
    connection.id;
}

test("identity-free recorded recovery persists consumer evidence before retirement", () => {
  const directory = mkdtempSync(join(tmpdir(), "identity-free-recorded-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const interruptedStore = createInterruptedTurnStore(
    join(directory, "interrupted"),
  );
  try {
    const record = interruptedStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-identity-free",
      toolCallIds: [],
      results: [],
      requestOtid: "request-identity-free",
      workingDirectory: "/identity-free",
      durableInputIdentities: [],
      terminalConsumerIds: ["slack:agent-1"],
    });

    expect(
      prepareRecordedInputTerminal(
        listener,
        terminalStore,
        runtime,
        record,
        record.runId,
      ),
    ).toBe(true);
    expect(loadPreparedInputTerminals(listener)).toEqual([]);
    const terminal = terminalStore.read("agent-1", "conv-1")?.terminals[0];
    expect(terminal?.requiredConsumerIds).toEqual(["slack:agent-1"]);
    expect(terminal?.owner).toMatchObject({
      connectionId: null,
      canRotate: true,
      interruptedRevision: record.revision,
    });
    expect(
      hasRecordedTerminalEvidence(listener, terminalStore, {
        agentId: "agent-1",
        conversationId: "conv-1",
        runtimeKey: runtime.key,
        identities: [],
        revision: record.revision ?? "",
      }),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identity-free recorded retry reuses the put-committed owner after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "identity-free-owner-retry-"));
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const interruptedStore = createInterruptedTurnStore(
    join(directory, "interrupted"),
  );
  try {
    const record = interruptedStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-owner-retry",
      toolCallIds: [],
      results: [],
      requestOtid: "request-owner-retry",
      workingDirectory: "/owner-retry",
      durableInputIdentities: [],
      terminalConsumerIds: ["slack:agent-1"],
    });
    const firstListener = createRuntime();
    installTerminalOwner(firstListener, "connection-a");
    const firstRuntime = getOrCreateScopedRuntime(
      firstListener,
      "agent-1",
      "conv-1",
    );
    expect(
      prepareRecordedInputTerminal(
        firstListener,
        terminalStore,
        firstRuntime,
        record,
        record.runId,
      ),
    ).toBe(true);
    const original = terminalStore.read("agent-1", "conv-1")?.terminals[0];
    expect(original?.owner.connectionId).toBe("connection-a");

    const restarted = createRuntime();
    installTerminalOwner(restarted, "connection-b");
    expect(
      prepareRecordedInputTerminal(
        restarted,
        terminalStore,
        getOrCreateScopedRuntime(restarted, "agent-1", "conv-1"),
        record,
        record.runId,
      ),
    ).toBe(true);
    const terminals = terminalStore.read("agent-1", "conv-1")?.terminals;
    expect(terminals).toHaveLength(1);
    expect(terminals?.[0]?.message).toEqual(original?.message);
    expect(terminals?.[0]?.owner).toEqual(original?.owner);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale terminal cleanup failures defer startup and converge on later promotion", () => {
  const directory = mkdtempSync(join(tmpdir(), "stale-terminal-cleanup-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const identity = ordinaryInputIdentity("cm-stale-cleanup");
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
            {
              role: "user",
              content: "run",
              client_message_id: "cm-stale-cleanup",
            },
          ],
        },
      }),
    ).toBe(true);
    const owner = {
      connectionId: null,
      canRotate: true,
      lineageId: null,
      terminalIdentity: "terminal-stale-cleanup",
      interruptedRevision: "revision-old",
      recoveryLineageId: "lineage-old",
      interruptedAuthorityRevision: "authority-old",
    };
    const message = {
      type: "turn_finished" as const,
      turn_id: "turn-stale-cleanup",
      stop_reason: "end_turn" as const,
      terminal_consumer_ids: ["slack:agent-1"],
    };
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message,
        owner,
      }),
    ).toBe(true);
    terminalStore.put("agent-1", "conv-1", message, owner);
    const interruptedStore = {
      readRetiredRecoveryAuthority: () => null,
      readRecoverySnapshot: () => ({
        record: {
          agentId: "agent-1",
          conversationId: "conv-1",
          runId: "run-new",
          toolCallIds: [],
          results: [],
          requestOtid: "request-new",
          workingDirectory: "/new",
          revision: "revision-new",
        },
        revisionToken: "authority-new",
      }),
    };
    let readAttempts = 0;
    let removeAttempts = 0;
    const retryingStore = {
      ...terminalStore,
      readOrThrow: (...args: Parameters<typeof terminalStore.readOrThrow>) => {
        readAttempts += 1;
        if (readAttempts === 1) throw new Error("transient terminal read lock");
        return terminalStore.readOrThrow(...args);
      },
      remove: (...args: Parameters<typeof terminalStore.remove>) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("transient terminal lock");
        return terminalStore.remove(...args);
      },
    };
    let discardAttempts = 0;
    const retryingDiscard: typeof discardPreparedInputTerminal = (...args) => {
      discardAttempts += 1;
      if (discardAttempts === 1) return false;
      return discardPreparedInputTerminal(...args);
    };

    expect(() =>
      promotePreparedInputTerminals(
        listener,
        retryingStore,
        undefined,
        interruptedStore,
        retryingDiscard,
      ),
    ).not.toThrow();
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);

    expect(() =>
      promotePreparedInputTerminals(
        listener,
        retryingStore,
        undefined,
        interruptedStore,
        retryingDiscard,
      ),
    ).not.toThrow();
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);

    expect(
      promotePreparedInputTerminals(
        listener,
        retryingStore,
        undefined,
        interruptedStore,
        retryingDiscard,
      ),
    ).toBe(0);
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
    expect(terminalStore.read("agent-1", "conv-1")).toBeNull();

    expect(
      promotePreparedInputTerminals(
        listener,
        retryingStore,
        undefined,
        interruptedStore,
        retryingDiscard,
      ),
    ).toBe(0);
    expect(loadPreparedInputTerminals(listener)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup promotion contains load put and post-put clear failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "promotion-io-failures-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const interruptedStore = createInterruptedTurnStore(
    join(directory, "interrupted"),
  );
  const identity = ordinaryInputIdentity("cm-promotion-io");
  if (!identity) throw new Error("missing promotion identity");
  try {
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: {
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [
            {
              role: "user",
              content: "run",
              client_message_id: "cm-promotion-io",
            },
          ],
        },
      }),
    ).toBe(true);
    const owner = {
      connectionId: "connection-promotion",
      canRotate: false,
      lineageId: null,
      terminalIdentity: "terminal-promotion-io",
      interruptedRevision: "revision-promotion-io",
    };
    const message = {
      type: "turn_finished" as const,
      turn_id: "turn-promotion-io",
      stop_reason: "end_turn" as const,
      terminal_consumer_ids: ["slack:agent-1"],
    };
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message,
        owner,
      }),
    ).toBe(true);

    expect(() =>
      promotePreparedInputTerminals(
        listener,
        terminalStore,
        undefined,
        interruptedStore,
        undefined,
        undefined,
        () => {
          throw new Error("transient journal read");
        },
      ),
    ).not.toThrow();
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);

    const failingPutStore = {
      ...terminalStore,
      put: () => {
        throw new Error("transient terminal write");
      },
    };
    expect(() =>
      promotePreparedInputTerminals(listener, failingPutStore),
    ).not.toThrow();
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);

    expect(
      promotePreparedInputTerminals(
        listener,
        terminalStore,
        undefined,
        interruptedStore,
        undefined,
        () => false,
      ),
    ).toBe(0);
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);

    expect(promotePreparedInputTerminals(listener, terminalStore)).toBe(1);
    expect(loadPreparedInputTerminals(listener)).toEqual([]);
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retained recovery journals schedule bounded promotion retries without an external wake", async () => {
  const directory = mkdtempSync(join(tmpdir(), "promotion-timer-retry-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const identity = ordinaryInputIdentity("cm-promotion-timer");
  if (!identity) throw new Error("missing promotion identity");
  try {
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: {
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [
            {
              role: "user",
              content: "run",
              client_message_id: "cm-promotion-timer",
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message: {
          type: "turn_finished",
          turn_id: "turn-promotion-timer",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-1"],
        },
        owner: {
          connectionId: null,
          canRotate: true,
          lineageId: null,
          terminalIdentity: "terminal-promotion-timer",
          interruptedRevision: "revision-promotion-timer",
          recoveryLineageId: "lineage-promotion-timer",
          interruptedAuthorityRevision: "authority-promotion-timer",
        },
      }),
    ).toBe(true);
    let attempts = 0;
    const absentAuthority = {
      readRetiredRecoveryAuthority: () => null,
      readRecoverySnapshot: () => {
        attempts += 1;
        return null;
      },
    };
    listener.promotePreparedInputTerminals = () =>
      promotePreparedInputTerminals(
        listener,
        terminalStore,
        undefined,
        absentAuthority,
      );
    expect(listener.promotePreparedInputTerminals()).toBe(0);
    expect(
      promotePreparedInputTerminals(
        listener,
        terminalStore,
        { agentId: "agent-other", conversationId: "conv-other" },
        absentAuthority,
      ),
    ).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    listener.intentionallyClosed = true;
    expect(attempts).toBeGreaterThan(1);
    expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recorded recovery reuses a put-committed prepared identity on retry", () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-terminal-retry-"));
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const interruptedStore = createInterruptedTurnStore(
    join(directory, "interrupted"),
  );
  const identity = ordinaryInputIdentity("cm-recorded-retry");
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
            {
              role: "user",
              content: "run",
              client_message_id: "cm-recorded-retry",
            },
          ],
        },
      }),
    ).toBe(true);
    const record = interruptedStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-recorded-retry",
      toolCallIds: [],
      results: [],
      requestOtid: "request-recorded-retry",
      workingDirectory: "/retry",
      durableInputIdentities: [identity],
      terminalConsumerIds: ["slack:agent-1"],
    });
    const message = {
      type: "turn_finished" as const,
      turn_id: "turn-recorded-retry",
      stop_reason: "end_turn" as const,
      terminal_consumer_ids: ["slack:agent-1"],
      run_id: "run-recorded-retry",
    };
    const owner = {
      connectionId: null,
      canRotate: true,
      lineageId: null,
      terminalIdentity: "terminal-recorded-retry",
      interruptedRevision: record.revision,
    };
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message,
        owner,
      }),
    ).toBe(true);
    terminalStore.put("agent-1", "conv-1", message, owner);

    expect(
      prepareRecordedInputTerminal(
        listener,
        terminalStore,
        runtime,
        record,
        record.runId,
      ),
    ).toBe(true);
    expect(loadPreparedInputTerminals(listener)).toEqual([]);
    const terminals = terminalStore.read("agent-1", "conv-1")?.terminals;
    expect(terminals).toHaveLength(1);
    expect(terminals?.[0]?.message).toEqual(message);
    expect(terminals?.[0]?.owner).toEqual({
      ...owner,
      preparationSequence: expect.any(Number),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test.each([true, false])(
  "retired authority converges stale and winning journals (persisted=%s)",
  (persistedWinner) => {
    const directory = mkdtempSync(
      join(tmpdir(), "retired-terminal-authority-"),
    );
    const listener = createRuntime();
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: null });
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
    const interruptedStore = createInterruptedTurnStore(
      join(directory, "interrupted"),
    );
    const identity = ordinaryInputIdentity("cm-retired-authority");
    const staleIdentity = ordinaryInputIdentity("cm-retired-stale");
    if (!identity) throw new Error("missing input identity");
    if (!staleIdentity) throw new Error("missing stale input identity");
    try {
      for (const inputIdentity of [identity, staleIdentity]) {
        const reservation = reserveInputDisposition(runtime, inputIdentity);
        if (reservation.kind !== "reserved")
          throw new Error("expected reservation");
        expect(
          commitInputDisposition(runtime, reservation.reservation, "started"),
        ).toBe(true);
      }
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
        connectionId: "connection-retired",
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
        terminal_consumer_ids: ["slack:agent-1"],
      };
      expect(
        prepareInputTerminal(runtime, [staleIdentity], {
          preparationSequence: 1,
          scope: { agentId: "agent-1", conversationId: "conv-1" },
          message: {
            ...message,
            turn_id: "turn-retired-stale",
          },
          owner: {
            ...owner,
            terminalIdentity: "terminal-retired-stale",
            interruptedAuthorityRevision: "authority-stale",
          },
        }),
      ).toBe(true);
      expect(
        prepareInputTerminal(runtime, [identity], {
          preparationSequence: 2,
          scope: { agentId: "agent-1", conversationId: "conv-1" },
          message,
          owner,
        }),
      ).toBe(true);
      if (persistedWinner) {
        terminalStore.put("agent-1", "conv-1", message, owner);
      }
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

      if (!persistedWinner) {
        const winner = loadPreparedInputTerminals(listener).find(
          (candidate) =>
            candidate.owner.terminalIdentity === "terminal-retired-authority",
        );
        if (!winner) throw new Error("missing winning journal");
        expect(
          promotePreparedInputTerminals(
            listener,
            terminalStore,
            undefined,
            interruptedStore,
            discardPreparedInputTerminal,
            clearPreparedInputTerminal,
            () => [winner],
          ),
        ).toBe(1);
        expect(loadPreparedInputTerminals(listener)).toHaveLength(1);
        expect(
          promotePreparedInputTerminals(
            listener,
            terminalStore,
            undefined,
            interruptedStore,
          ),
        ).toBe(0);
      } else {
        expect(
          promotePreparedInputTerminals(
            listener,
            terminalStore,
            undefined,
            interruptedStore,
          ),
        ).toBe(1);
      }
      expect(loadPreparedInputTerminals(listener)).toEqual([]);
      expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(
        1,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
