import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import type { ListenerTransport } from "./transport";
import {
  createTurnFinishedStore,
  replayPendingTurnFinishedToConnection,
} from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";

test("agent-free replay never deletes recovery-lineage evidence it cannot validate", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-free-terminal-"));
  try {
    const store = createTurnFinishedStore(directory);
    store.put(
      null,
      "conversation-agent-free",
      {
        type: "turn_finished",
        turn_id: "turn-agent-free-lineage",
        stop_reason: "end_turn",
        terminal_consumer_ids: ["slack:agent-free"],
      },
      {
        connectionId: null,
        canRotate: true,
        lineageId: null,
        terminalIdentity: "terminal-agent-free-lineage",
        interruptedRevision: "revision-agent-free",
        interruptedAuthorityRevision: "authority-agent-free",
        recoveryLineageId: "lineage-agent-free",
      },
    );
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      null,
      "conversation-agent-free",
    );
    const sent: string[] = [];
    const transport: ListenerTransport = {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: (payload: string) => sent.push(payload),
    };
    const connection = openListenerConnection({
      runtime: listener,
      connectionId: "conn-agent-free",
      writer: transport,
      options: {
        connectionId: "conn-agent-free",
        wsUrl: "local://test",
        deviceId: "device-agent-free",
        connectionName: "agent-free",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    });
    subscribeListenerConnection(listener, connection.id, {
      agent_id: null,
      conversation_id: "conversation-agent-free",
    });
    markListenerConnectionInitialized(listener, connection.id, connection);

    replayPendingTurnFinishedToConnection(
      transport,
      runtime,
      connection.id,
      store,
    );

    expect(sent).toEqual([]);
    expect(
      store
        .read(null, "conversation-agent-free")
        ?.terminals.map((terminal) => terminal.message.turn_id),
    ).toEqual(["turn-agent-free-lineage"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale finalizer cannot delete a newer authority terminal", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-authority-race-"));
  try {
    const store = createTurnFinishedStore(directory);
    const staleRuntime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conversation-1",
    );
    const currentRuntime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conversation-1",
    );
    const staleLease = staleRuntime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    const currentLease = currentRuntime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    const socket: ListenerTransport = {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    };
    let authority = "authority-1";
    let interleaved = false;
    const interleavingStore = {
      ...store,
      put: (...args: Parameters<typeof store.put>) => {
        const terminal = store.put(...args);
        if (!interleaved && args[2].turn_id === "turn-authority-1") {
          interleaved = true;
          authority = "authority-2";
          expect(
            finishListenerTurn(currentRuntime, currentLease, {
              socket,
              turnId: "turn-authority-2",
              stopReason: "end_turn",
              agentId: "agent-1",
              conversationId: "conversation-1",
              terminalConsumerIds: ["slack:agent-1"],
              turnFinishedStore: store,
              expectedInterruptedAuthorityRevision: "authority-2",
              readInterruptedAuthorityRevision: () => authority,
              readInterruptedRevision: () => "revision-shared",
              recoveryLineageId: "lineage-shared",
              forgetWork: () => {},
            }).finished,
          ).toBe(true);
        }
        return terminal;
      },
    };

    const staleTransition = finishListenerTurn(staleRuntime, staleLease, {
      socket,
      turnId: "turn-authority-1",
      stopReason: "end_turn",
      agentId: "agent-1",
      conversationId: "conversation-1",
      terminalConsumerIds: ["slack:agent-1"],
      turnFinishedStore: interleavingStore,
      expectedInterruptedAuthorityRevision: "authority-1",
      readInterruptedAuthorityRevision: () => authority,
      readInterruptedRevision: () => "revision-shared",
      recoveryLineageId: "lineage-shared",
      forgetWork: () => {},
    });

    expect(staleTransition.finished).toBe(false);
    expect(
      store
        .read("agent-1", "conversation-1")
        ?.terminals.some(
          (terminal) =>
            terminal.owner.interruptedAuthorityRevision === "authority-2" &&
            terminal.message.turn_id === "turn-authority-2",
        ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["exact", "legacy"] as const)(
  "%s retired lineage tombstone delivers only the winning authority terminal",
  (format) => {
    const directory = mkdtempSync(
      join(tmpdir(), `retired-terminal-${format}-authority-`),
    );
    try {
      const interruptedStore = createInterruptedTurnStore(
        join(directory, "interrupted"),
      );
      const terminalStore = createTurnFinishedStore(
        join(directory, "terminals"),
      );
      const predecessor = interruptedStore.write({
        agentId: "agent-1",
        conversationId: "conversation-1",
        runId: "run-predecessor",
        toolCallIds: ["call-predecessor"],
        results: [],
        requestOtid: "request-predecessor",
        workingDirectory: "/winning",
        durableInputIdentities: [{ domain: "input", id: "cm-winning" }],
        recoveryClaimCompletion: {
          lineageId: "lineage-shared",
          state: "running",
          effectToolCallIds: ["call-predecessor"],
        },
      });
      if (!predecessor.revision)
        throw new Error("missing predecessor revision");
      interruptedStore.write(
        {
          ...predecessor,
          runId: "run-successor",
          toolCallIds: ["call-successor"],
          requestOtid: "request-successor",
          recoveryClaimCompletion: {
            lineageId: "lineage-shared",
            state: "running",
            independentSuccessor: true,
            effectRevision: predecessor.revision,
            effectRunId: predecessor.runId,
            effectToolCallIds: predecessor.toolCallIds,
            effectRequestOtid: predecessor.requestOtid,
            effectWorkingDirectory: predecessor.workingDirectory,
            effectResults: predecessor.results,
            effectInputIdentities: predecessor.durableInputIdentities,
          },
        },
        predecessor.revision,
      );
      const running = interruptedStore.readRecoverySnapshot(
        "agent-1",
        "conversation-1",
        "lineage-shared",
      );
      if (!running) throw new Error("missing running sidecar authority");
      const owner = (
        authorityRevision: string,
        interruptedRevision: string,
      ) => ({
        connectionId: "connection-1",
        canRotate: false,
        lineageId: "startup-1",
        terminalIdentity: `terminal-${authorityRevision}`,
        interruptedRevision,
        recoveryLineageId: "lineage-shared",
        interruptedAuthorityRevision: authorityRevision,
      });
      terminalStore.put(
        "agent-1",
        "conversation-1",
        {
          type: "turn_finished",
          turn_id: "turn-stale",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-1"],
        },
        owner("authority-stale", "revision-stale"),
      );
      terminalStore.put(
        "agent-1",
        "conversation-1",
        {
          type: "turn_finished",
          turn_id: "turn-winning",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-1"],
        },
        owner(running.revisionToken, predecessor.revision),
      );
      const pending = interruptedStore.markRecoveryClaimCompletionPending({
        agentId: "agent-1",
        conversationId: "conversation-1",
        lineageId: "lineage-shared",
        expectedRevision: running.revisionToken,
      });
      if (!pending?.revision) throw new Error("missing pending revision");
      expect(
        interruptedStore.retireRecoveryClaimCompletion({
          agentId: "agent-1",
          conversationId: "conversation-1",
          lineageId: "lineage-shared",
          pendingRevision: pending.revision,
        }),
      ).toBe("preserved");
      const sidecar = readdirSync(join(directory, "interrupted")).find((file) =>
        file.includes(".json.recovery-"),
      );
      if (!sidecar) throw new Error("missing retired authority sidecar");
      const sidecarPath = join(directory, "interrupted", sidecar);
      const retired = JSON.parse(readFileSync(sidecarPath, "utf8"));
      if (format === "legacy") {
        const legacy = retired;
        delete legacy.retiredInterruptedRevision;
        delete legacy.retiredAuthorityRevision;
        delete legacy.retiredAt;
      } else {
        retired.retiredAt = Date.now() - 25 * 60 * 60 * 1_000;
      }
      writeFileSync(sidecarPath, JSON.stringify(retired), "utf8");
      interruptedStore.list();
      expect(
        interruptedStore.readRetiredRecoveryAuthority(
          "agent-1",
          "conversation-1",
          "lineage-shared",
        ),
      ).not.toBeNull();

      const listener = createRuntime();
      const runtime = getOrCreateScopedRuntime(
        listener,
        "agent-1",
        "conversation-1",
      );
      const sent: string[] = [];
      const transport: ListenerTransport = {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: (payload: string) => sent.push(payload),
      };
      const connection = openListenerConnection({
        runtime: listener,
        connectionId: "connection-1",
        writer: transport,
        options: {
          connectionId: "connection-1",
          wsUrl: "local://test",
          deviceId: "device-1",
          connectionName: "authority-winner",
          onConnected: () => {},
          onDisconnected: () => {},
          onError: () => {},
        },
      });
      subscribeListenerConnection(listener, connection.id, {
        agent_id: "agent-1",
        conversation_id: "conversation-1",
      });
      markListenerConnectionInitialized(listener, connection.id, connection);

      replayPendingTurnFinishedToConnection(
        transport,
        runtime,
        connection.id,
        terminalStore,
        interruptedStore,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("turn-winning");
      expect(
        terminalStore
          .read("agent-1", "conversation-1")
          ?.terminals.map((terminal) => terminal.message.turn_id),
      ).toEqual(["turn-winning"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
