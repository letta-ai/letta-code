import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  loadDurableQueuedInputs,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import {
  loadPreparedInputTerminals,
  prepareInputTerminal,
} from "./input-terminal-journal";
import { createRuntime } from "./lifecycle";
import { createTurnFinishedStore } from "./turn-finished-replay";
import { finishListenerTurn } from "./turn-terminal";
import type { IncomingMessage } from "./types";

function persistentRuntime(path: string) {
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
