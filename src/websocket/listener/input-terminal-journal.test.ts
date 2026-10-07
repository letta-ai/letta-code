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
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  hasCompletedInputTerminalRevision,
  loadDurableQueuedInputs,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import {
  loadPreparedInputTerminals,
  prepareInputTerminal,
} from "./input-terminal-journal";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import { getConversationRuntimeKey } from "./runtime";
import {
  acknowledgeTurnFinished,
  createTurnFinishedStore,
} from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";
import type { IncomingMessage } from "./types";

function persistentRuntime(path: string | null) {
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: path });
  return getOrCreateScopedRuntime(
    listener,
    "agent-durable",
    "conversation-durable",
  );
}

function durableIncoming(clientMessageId: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-durable",
    conversationId: "conversation-durable",
    messages: [
      {
        role: "user",
        content: "continue",
        client_message_id: clientMessageId,
      },
    ],
  };
}

function admitStartedInput(
  runtime: ReturnType<typeof persistentRuntime>,
  id: string,
) {
  const identity = ordinaryInputIdentity(id);
  if (!identity) throw new Error("expected durable input identity");
  const admission = reserveInputDisposition(runtime, identity);
  if (admission.kind !== "reserved") throw new Error("expected reservation");
  if (
    !commitInputDisposition(runtime, admission.reservation, "started", {
      incoming: durableIncoming(id),
    })
  ) {
    throw new Error("expected started disposition");
  }
  return identity;
}

function finishDurableInput(params: {
  runtime: ReturnType<typeof persistentRuntime>;
  identity: NonNullable<ReturnType<typeof ordinaryInputIdentity>>;
  terminalStore: ReturnType<typeof createTurnFinishedStore>;
  turnId: string;
  completePreparedInputTerminal?: Parameters<
    typeof finishListenerTurn
  >[2]["completePreparedInputTerminal"];
  forgetWork?: () => void;
}) {
  const lease = params.runtime.turnLifecycle.begin({
    origin: "approval_recovery",
    workingDirectory: process.cwd(),
  });
  return finishListenerTurn(params.runtime, lease, {
    socket: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    turnId: params.turnId,
    stopReason: "end_turn",
    agentId: "agent-durable",
    conversationId: "conversation-durable",
    terminalConsumerIds: ["slack:agent-durable"],
    durableInputIdentities: [params.identity],
    turnFinishedStore: params.terminalStore,
    completePreparedInputTerminal: params.completePreparedInputTerminal,
    forgetWork: params.forgetWork,
  });
}

test("restart promotes prepared terminal before accepted input can execute again", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-terminal-"));
  try {
    const path = join(root, "state.json");
    const terminalDirectory = join(root, "terminals");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-effect-committed");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: durableIncoming("cm-effect-committed"),
      }),
    ).toBe(true);
    expect(
      prepareInputTerminal(runtime, identity ? [identity] : [], {
        scope: {
          agentId: "agent-durable",
          conversationId: "conversation-durable",
        },
        message: {
          type: "turn_finished",
          turn_id: "turn-effect-committed",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-1"],
        },
        owner: {
          connectionId: "conn-owner",
          canRotate: false,
          lineageId: "lineage-owner",
        },
      }),
    ).toBe(true);

    const restarted = persistentRuntime(path);
    expect(loadDurableQueuedInputs(restarted.listener)).toEqual([]);
    expect(loadPreparedInputTerminals(restarted.listener)).toHaveLength(1);
    const terminalStore = createTurnFinishedStore(terminalDirectory);
    expect(restoreDurableQueuedInputs(restarted.listener, terminalStore)).toBe(
      0,
    );
    expect(loadPreparedInputTerminals(restarted.listener)).toEqual([]);
    expect(
      terminalStore
        .read("agent-durable", "conversation-durable")
        ?.terminals.map((terminal) => terminal.message.turn_id),
    ).toEqual(["turn-effect-committed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["put_then_throw", "clear_failure"] as const)(
  "finish recovery promotes one terminal after %s",
  (caseName) => {
    const root = mkdtempSync(join(tmpdir(), `letta-terminal-${caseName}-`));
    try {
      const path = join(root, "state.json");
      const terminalStore = createTurnFinishedStore(join(root, "terminals"));
      const runtime = persistentRuntime(path);
      const identity = admitStartedInput(runtime, `cm-${caseName}`);
      const store =
        caseName === "put_then_throw"
          ? ({
              ...terminalStore,
              put: (...args: Parameters<typeof terminalStore.put>) => {
                terminalStore.put(...args);
                throw new Error("crash after terminal put");
              },
            } as ReturnType<typeof createTurnFinishedStore>)
          : terminalStore;

      expect(() =>
        finishDurableInput({
          runtime,
          identity,
          terminalStore: store,
          turnId: `turn-${caseName}`,
          ...(caseName === "clear_failure"
            ? { completePreparedInputTerminal: () => false }
            : {}),
        }),
      ).toThrow();
      expect(loadPreparedInputTerminals(runtime.listener)).toHaveLength(1);

      const restarted = persistentRuntime(path);
      expect(
        restoreDurableQueuedInputs(restarted.listener, terminalStore),
      ).toBe(0);
      expect(loadPreparedInputTerminals(restarted.listener)).toEqual([]);
      expect(
        terminalStore.read("agent-durable", "conversation-durable")?.terminals,
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("terminal durability precedes destructive execution-evidence cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-terminal-before-forget-"));
  try {
    const path = join(root, "state.json");
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    const runtime = persistentRuntime(path);
    const identity = admitStartedInput(runtime, "cm-before-forget");
    let forgetAttempts = 0;

    expect(
      finishDurableInput({
        runtime,
        identity,
        terminalStore,
        turnId: "turn-before-forget",
        forgetWork: () => {
          forgetAttempts += 1;
          throw new Error("unlink failed");
        },
      }).finished,
    ).toBe(true);

    expect(forgetAttempts).toBe(1);
    expect(loadPreparedInputTerminals(runtime.listener)).toEqual([]);
    expect(loadDurableQueuedInputs(runtime.listener)).toEqual([]);
    expect(
      terminalStore.read("agent-durable", "conversation-durable")?.terminals,
    ).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal prepare failure releases the lifecycle lease", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-terminal-prepare-fail-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const identity = admitStartedInput(runtime, "cm-prepare-fail");
    const lease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    expect(() =>
      finishListenerTurn(runtime, lease, {
        socket: {
          kind: "local",
          bufferedAmount: 0,
          isOpen: () => true,
          send: () => {},
        },
        turnId: "turn-prepare-fail",
        stopReason: "error",
        agentId: runtime.agentId,
        conversationId: runtime.conversationId,
        terminalConsumerIds: ["slack:agent-durable"],
        durableInputIdentities: [identity],
        prepareInputTerminal: () => false,
      }),
    ).toThrow("Failed to atomically prepare accepted-input terminal");
    expect(runtime.turnLifecycle.kind).toBe("idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same local turn id in two conversations promotes both exact journals", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-terminal-scope-"));
  try {
    const listener = createRuntime();
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({
        persistentPath: join(root, "state.json"),
      });
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    for (const conversationId of ["conversation-a", "conversation-b"]) {
      const runtime = getOrCreateScopedRuntime(
        listener,
        "agent-durable",
        conversationId,
      );
      const identity = ordinaryInputIdentity(`cm-${conversationId}`);
      const admission = reserveInputDisposition(runtime, identity);
      if (admission.kind !== "reserved")
        throw new Error("expected reservation");
      expect(
        commitInputDisposition(runtime, admission.reservation, "started", {
          incoming: {
            ...durableIncoming(`cm-${conversationId}`),
            conversationId,
          },
        }),
      ).toBe(true);
      expect(
        prepareInputTerminal(runtime, identity ? [identity] : [], {
          scope: { agentId: "agent-durable", conversationId },
          message: {
            type: "turn_finished",
            turn_id: "batch-1",
            stop_reason: "end_turn",
            terminal_consumer_ids: ["slack:agent-durable"],
          },
          owner: {
            connectionId: "conn-owner",
            canRotate: false,
            lineageId: "lineage-owner",
          },
        }),
      ).toBe(true);
    }

    expect(loadPreparedInputTerminals(listener)).toHaveLength(2);
    expect(promotePreparedInputTerminals(listener, terminalStore)).toBe(2);
    expect(
      terminalStore.read("agent-durable", "conversation-a")?.terminals,
    ).toHaveLength(1);
    expect(
      terminalStore.read("agent-durable", "conversation-b")?.terminals,
    ).toHaveLength(1);
    expect(loadPreparedInputTerminals(listener)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-scope batch id reused after restart preserves both operations", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-terminal-incarnation-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    for (const suffix of ["old", "new"]) {
      const identity = admitStartedInput(runtime, `cm-${suffix}`);
      expect(
        prepareInputTerminal(runtime, [identity], {
          scope: {
            agentId: runtime.agentId,
            conversationId: runtime.conversationId,
          },
          message: {
            type: "turn_finished",
            turn_id: "batch-1",
            stop_reason: "end_turn",
            terminal_consumer_ids: ["slack:agent-durable"],
          },
          owner: {
            connectionId: "conn-owner",
            canRotate: false,
            lineageId: "lineage-owner",
            terminalIdentity: `terminal-${suffix}`,
          },
        }),
      ).toBe(true);
    }

    expect(loadPreparedInputTerminals(runtime.listener)).toHaveLength(2);
    expect(promotePreparedInputTerminals(runtime.listener, terminalStore)).toBe(
      2,
    );
    const terminals = terminalStore.read(
      runtime.agentId,
      runtime.conversationId,
    )?.terminals;
    expect(terminals).toHaveLength(2);
    expect(
      terminals?.map((terminal) => terminal.owner.terminalIdentity),
    ).toEqual(["terminal-old", "terminal-new"]);
    expect(loadPreparedInputTerminals(runtime.listener)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous legacy same-scope terminal identity fails closed", () => {
  const runtime = persistentRuntime(null);
  for (const suffix of ["old", "new"]) {
    const identity = admitStartedInput(runtime, `cm-legacy-${suffix}`);
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message: {
          type: "turn_finished",
          turn_id: "batch-1",
          stop_reason: "end_turn",
        },
        owner: {
          connectionId: `conn-${suffix}`,
          canRotate: false,
          lineageId: `lineage-${suffix}`,
        },
      }),
    ).toBe(true);
  }
  expect(() => loadPreparedInputTerminals(runtime.listener)).toThrow(
    "Prepared terminal identity collision",
  );
});

test("full terminal capacity defers a prepared journal until ACK frees space", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-terminal-capacity-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    const owner = {
      connectionId: "conn-owner",
      canRotate: false,
      lineageId: "lineage-owner",
    };
    for (let index = 0; index < 64; index += 1) {
      terminalStore.put(
        runtime.agentId,
        runtime.conversationId,
        {
          type: "turn_finished",
          turn_id: `turn-existing-${index}`,
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-durable"],
        },
        owner,
      );
    }
    const identity = admitStartedInput(runtime, "cm-capacity-pending");
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message: {
          type: "turn_finished",
          turn_id: "turn-capacity-pending",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-durable"],
        },
        owner,
      }),
    ).toBe(true);

    expect(promotePreparedInputTerminals(runtime.listener, terminalStore)).toBe(
      0,
    );
    expect(loadPreparedInputTerminals(runtime.listener)).toHaveLength(1);
    const existing = terminalStore.read(runtime.agentId, runtime.conversationId)
      ?.terminals[0];
    expect(existing).toBeDefined();
    expect(
      terminalStore.claim(
        runtime.agentId,
        runtime.conversationId,
        existing?.id ?? "",
        "conn-owner",
      ),
    ).not.toBeNull();
    expect(
      acknowledgeTurnFinished({
        agentId: runtime.agentId,
        conversationId: runtime.conversationId,
        connectionId: "conn-owner",
        idempotencyKey: existing?.id ?? "",
        consumerId: "slack:agent-durable",
        store: terminalStore,
      }),
    ).toBe(true);
    expect(promotePreparedInputTerminals(runtime.listener, terminalStore)).toBe(
      1,
    );
    expect(loadPreparedInputTerminals(runtime.listener)).toEqual([]);
    expect(
      terminalStore
        .read(runtime.agentId, runtime.conversationId)
        ?.terminals.some(
          (terminal) => terminal.message.turn_id === "turn-capacity-pending",
        ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promoted terminal leaves a revision fence after its replay record retires", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-terminal-revision-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    const identity = admitStartedInput(runtime, "cm-revision");
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message: {
          type: "turn_finished",
          turn_id: "turn-revision",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-durable"],
        },
        owner: {
          connectionId: "conn-owner",
          canRotate: false,
          lineageId: "lineage-owner",
          interruptedRevision: "revision-1",
        },
      }),
    ).toBe(true);

    expect(promotePreparedInputTerminals(runtime.listener, terminalStore)).toBe(
      1,
    );
    const terminal = terminalStore.read(runtime.agentId, runtime.conversationId)
      ?.terminals[0];
    expect(terminal?.owner.interruptedRevision).toBe("revision-1");
    expect(
      terminalStore.claim(
        runtime.agentId,
        runtime.conversationId,
        terminal?.id ?? "",
        "conn-owner",
      ),
    ).not.toBeNull();
    expect(
      acknowledgeTurnFinished({
        agentId: runtime.agentId,
        conversationId: runtime.conversationId,
        connectionId: "conn-owner",
        idempotencyKey: terminal?.id ?? "",
        consumerId: "slack:agent-durable",
        store: terminalStore,
      }),
    ).toBe(true);
    expect(
      terminalStore.read(runtime.agentId, runtime.conversationId),
    ).toBeNull();
    expect(
      hasCompletedInputTerminalRevision(
        runtime.listener,
        getConversationRuntimeKey(runtime.agentId, runtime.conversationId),
        [identity],
        "revision-1",
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup leaves a started input to its matching interrupted record", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-started-priority-"));
  try {
    const statePath = join(root, "state.json");
    const original = persistentRuntime(statePath);
    const identity = ordinaryInputIdentity("cm-started-owned");
    if (!identity) throw new Error("expected identity");
    const admission = reserveInputDisposition(original, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(original, admission.reservation, "started", {
        incoming: durableIncoming("cm-started-owned"),
      }),
    ).toBe(true);

    const restarted = persistentRuntime(statePath);
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    expect(
      restoreDurableQueuedInputs(restarted.listener, terminalStore, [
        {
          revision: "revision-owned",
          agentId: "agent-durable",
          conversationId: "conversation-durable",
          runId: "run-owned",
          toolCallIds: ["call-owned"],
          results: [],
          requestOtid: "otid-owned",
          workingDirectory: "/project",
          durableInputIdentities: [identity],
        },
      ]),
    ).toBe(0);
    expect(restarted.queueRuntime.isEmpty).toBe(true);

    expect(
      restoreDurableQueuedInputs(restarted.listener, terminalStore, []),
    ).toBe(1);
    expect(restarted.queueRuntime.isEmpty).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restored durable input retains the current physical terminal owner", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-restored-owner-"));
  try {
    const statePath = join(root, "state.json");
    const original = persistentRuntime(statePath);
    const identity = ordinaryInputIdentity("cm-restored-owner");
    if (!identity) throw new Error("expected identity");
    const admission = reserveInputDisposition(original, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(original, admission.reservation, "queued", {
        incoming: durableIncoming("cm-restored-owner"),
      }),
    ).toBe(true);

    const restarted = persistentRuntime(statePath);
    openListenerConnection({
      runtime: restarted.listener,
      connectionId: "physical-owner",
      writer: {
        kind: "runtime",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      options: {
        connectionId: "physical-owner",
        wsUrl: "local://test",
        deviceId: "device-owner",
        connectionName: "Owner",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    });
    subscribeListenerConnection(restarted.listener, "physical-owner", {
      agent_id: restarted.agentId,
      conversation_id: restarted.conversationId,
    });
    markListenerConnectionInitialized(restarted.listener, "physical-owner");

    expect(
      restoreDurableQueuedInputs(
        restarted.listener,
        createTurnFinishedStore(join(root, "terminals")),
        [],
      ),
    ).toBe(1);
    expect(consumeQueuedTurn(restarted)?.queuedTurn.connectionId).toBe(
      "physical-owner",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion immediately replays a deferred terminal to its new exact owner", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-promoted-replay-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const identity = admitStartedInput(runtime, "cm-promoted-replay");
    const sent: unknown[] = [];
    openListenerConnection({
      runtime: runtime.listener,
      connectionId: "conn-owner",
      writer: {
        kind: "runtime",
        bufferedAmount: 0,
        isOpen: () => true,
        send: (payload: string) => sent.push(JSON.parse(payload)),
      },
      options: {
        connectionId: "conn-owner",
        wsUrl: "local://test",
        deviceId: "device-owner",
        connectionName: "Owner",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    });
    subscribeListenerConnection(runtime.listener, "conn-owner", {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    });
    markListenerConnectionInitialized(runtime.listener, "conn-owner");
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message: {
          type: "turn_finished",
          turn_id: "turn-promoted-replay",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-durable"],
        },
        owner: {
          connectionId: null,
          canRotate: true,
          lineageId: null,
          terminalIdentity: "terminal-promoted-replay",
        },
      }),
    ).toBe(true);

    expect(
      promotePreparedInputTerminals(
        runtime.listener,
        createTurnFinishedStore(join(root, "terminals")),
      ),
    ).toBe(1);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "turn_finished",
        turn_id: "turn-promoted-replay",
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion never overwrites an unrelated active connection", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-promoted-owner-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const identity = admitStartedInput(runtime, "cm-owner-fence");
    runtime.activeConnectionId = "conn-unrelated";
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message: {
          type: "turn_finished",
          turn_id: "turn-owner-fence",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-durable"],
        },
        owner: {
          connectionId: null,
          canRotate: true,
          lineageId: null,
          terminalIdentity: "terminal-owner-fence",
        },
      }),
    ).toBe(true);

    expect(
      promotePreparedInputTerminals(
        runtime.listener,
        createTurnFinishedStore(join(root, "terminals")),
      ),
    ).toBe(0);
    expect(runtime.activeConnectionId).toBe("conn-unrelated");
    expect(loadPreparedInputTerminals(runtime.listener)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion reconciles an already-persisted terminal without owner collision", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-promoted-existing-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const identity = admitStartedInput(runtime, "cm-existing-terminal");
    const terminalStore = createTurnFinishedStore(join(root, "terminals"));
    const message = {
      type: "turn_finished" as const,
      turn_id: "turn-existing-terminal",
      stop_reason: "end_turn" as const,
      terminal_consumer_ids: ["slack:agent-durable"],
    };
    terminalStore.put(runtime.agentId, runtime.conversationId, message, {
      connectionId: "conn-original",
      canRotate: false,
      lineageId: "lineage-original",
      terminalIdentity: "terminal-existing",
    });
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: {
          agentId: runtime.agentId,
          conversationId: runtime.conversationId,
        },
        message,
        owner: {
          connectionId: "conn-reassigned-before-crash",
          canRotate: false,
          lineageId: "lineage-reassigned",
          terminalIdentity: "terminal-existing",
        },
      }),
    ).toBe(true);

    expect(promotePreparedInputTerminals(runtime.listener, terminalStore)).toBe(
      1,
    );
    expect(loadPreparedInputTerminals(runtime.listener)).toEqual([]);
    const terminals = terminalStore.read(
      runtime.agentId,
      runtime.conversationId,
    )?.terminals;
    expect(terminals).toHaveLength(1);
    expect(terminals?.[0]?.owner.connectionId).toBe("conn-original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
