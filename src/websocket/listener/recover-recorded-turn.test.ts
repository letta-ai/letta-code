import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { prepareInputTerminal } from "./input-terminal-journal";

test("one recovered long-running turn does not block another conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-many-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const sent: string[] = [];
  try {
    for (const conversationId of ["conv-a", "conv-b"])
      store.write({
        agentId: "agent-1",
        conversationId,
        runId: "run-1",
        toolCallIds: ["call-1"],
        results: [],
        requestOtid: conversationId,
        workingDirectory: "/project",
      });
    await recoverRecordedTurns(listener, {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          { toolCallId: "call-1", toolName: "Bash", toolArgs: "{}" },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      setCwd: () => {},
      processTurn: async (message) => {
        sent.push(message.conversationId ?? "missing");
        await new Promise(() => {});
      },
    });
    expect(sent.sort()).toEqual(["conv-a", "conv-b"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a successful teleport receipt retires saved work without sending results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-teleport-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
      teleportId: "teleport-1",
    });
    await recoverRecordedTurns(listener, {
      store,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      teleportStatus: (async () => ({ status: "completed" })) as never,
      processTurn: async () => {
        throw new Error("must not resume transferred work");
      },
    });
    expect(store.read("agent-1", "conv-1")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a revision-matched durable terminal retires the interrupted record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-terminal-revision-"));
  const store = createInterruptedTurnStore(join(directory, "interrupted"));
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
    });
    const persisted = store.read("agent-1", "conv-1");
    if (!persisted?.revision) throw new Error("expected persisted revision");
    terminalStore.put(
      "agent-1",
      "conv-1",
      {
        type: "turn_finished",
        turn_id: "turn-revision-owned",
        stop_reason: "end_turn",
        terminal_consumer_ids: ["slack:agent-1"],
      },
      {
        connectionId: "conn-owner",
        canRotate: false,
        lineageId: "lineage-owner",
        interruptedRevision: persisted.revision,
      },
    );

    await recoverRecordedTurns(listener, { store, terminalStore });
    expect(store.read("agent-1", "conv-1")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a prepared revision is promoted before recorded work can replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-prepared-revision-"));
  const store = createInterruptedTurnStore(join(directory, "interrupted"));
  const terminalStore = createTurnFinishedStore(join(directory, "terminals"));
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({
      persistentPath: join(directory, "inputs.json"),
    });
  try {
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const identity = ordinaryInputIdentity("cm-effect-complete");
    if (!identity) throw new Error("expected identity");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: {
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [{ role: "user", content: "effect" }],
        },
      }),
    ).toBe(true);
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
      durableInputIdentities: [identity],
    });
    const revision = store.read("agent-1", "conv-1")?.revision;
    if (!revision) throw new Error("expected revision");
    expect(
      prepareInputTerminal(runtime, [identity], {
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        message: {
          type: "turn_finished",
          turn_id: "batch-1",
          stop_reason: "end_turn",
          terminal_consumer_ids: ["slack:agent-1"],
        },
        owner: {
          connectionId: "conn-owner",
          canRotate: false,
          lineageId: "lineage-owner",
          terminalIdentity: "terminal-effect-complete",
          interruptedRevision: revision,
        },
      }),
    ).toBe(true);
    const resume = mock(async () => {
      throw new Error("completed effect must not replay");
    });

    await recoverRecordedTurns(listener, {
      store,
      terminalStore,
      resume: resume as never,
    });
    expect(resume).toHaveBeenCalledTimes(0);
    expect(store.read("agent-1", "conv-1")).toBeNull();
    expect(terminalStore.read("agent-1", "conv-1")?.terminals).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { setActiveRuntime } from "./runtime";
import type { handleIncomingMessage } from "./turn";
import { createTurnFinishedStore } from "./turn-finished-replay";
import type { IncomingMessage } from "./types";

const acquireTestClaim = async () => {
  let owned = true;
  return {
    get owned() {
      return owned;
    },
    complete: async () => {
      owned = false;
      return true;
    },
    release: async () => {
      owned = false;
    },
    abandon: () => {
      owned = false;
    },
  } as never;
};

test("post-start claim loss schedules one coalesced recorded recovery retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-claim-loss-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  setActiveRuntime(listener);
  const lostCallbacks: Array<() => void> = [];
  const pendingTurns: Array<() => void> = [];
  const terminalGuards: Array<() => boolean> = [];
  let starts = 0;
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
    });
    const deps = {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          { toolCallId: "call-1", toolName: "Bash", toolArgs: "{}" },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: (async (_runtime: unknown, onLost: () => void) => {
        let owned = true;
        lostCallbacks.push(() => {
          owned = false;
          onLost();
        });
        return {
          get owned() {
            return owned;
          },
          complete: async () => false,
          release: async () => {},
          abandon: () => {},
        } as never;
      }) as never,
      setCwd: () => {},
      processTurn: async (
        ...args: Parameters<typeof handleIncomingMessage>
      ) => {
        starts += 1;
        terminalGuards.push(args[8] ?? (() => true));
        await new Promise<void>((resolve) => pendingTurns.push(resolve));
      },
    };

    await recoverRecordedTurns(listener, deps);
    expect(starts).toBe(1);
    lostCallbacks[0]?.();
    lostCallbacks[0]?.();
    expect(terminalGuards[0]?.()).toBe(false);
    // A successor must not begin until the detached predecessor has unwound.
    await Bun.sleep(10);
    expect(starts).toBe(1);
    pendingTurns.shift()?.();
    await Bun.sleep(10);
    expect(starts).toBe(2);
  } finally {
    listener.intentionallyClosed = true;
    for (const resolve of pendingTurns) resolve();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a detached recovered turn rejection releases its lease and retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-rejection-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  setActiveRuntime(listener);
  let starts = 0;
  let releases = 0;
  const pendingTurns: Array<() => void> = [];
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-1",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          { toolCallId: "call-1", toolName: "Bash", toolArgs: "{}" },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: (async () => ({
        owned: true,
        complete: async () => false,
        release: async () => {
          releases += 1;
        },
        abandon: () => {},
      })) as never,
      setCwd: () => {},
      processTurn: async () => {
        starts += 1;
        if (starts === 1) throw new Error("detached continuation failed");
        await new Promise<void>((resolve) => pendingTurns.push(resolve));
      },
    });
    for (let attempt = 0; attempt < 100 && starts < 2; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(releases).toBeGreaterThanOrEqual(1);
    expect(starts).toBe(2);
  } finally {
    listener.intentionallyClosed = true;
    for (const resolve of pendingTurns) resolve();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an accepted continuation still generating output is retained even with no pending tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-generating-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-old",
      toolCallIds: ["old-tool"],
      results: [
        { tool_call_id: "old-tool", status: "success", tool_return: "output" },
      ],
      requestOtid: "accepted-request",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        retrieveRun: async (id: string) => {
          expect(id).toBe("run-new");
          return { status: "running" };
        },
        streamConversationMessages: async () => ({
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {
            yield { run_id: "run-new" };
          },
        }),
      } as never,
      resume: (async () => ({ pendingApprovals: [] })) as never,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      processTurn: async () => {
        throw new Error("cannot send while the accepted run is generating");
      },
    });
    expect(store.read("agent-1", "conv-1")?.requestOtid).toBe(
      "accepted-request",
    );
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepted result request is found by OTID if the listener died before seeing its new run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-ack-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-old",
      toolCallIds: ["old-tool"],
      results: [
        { tool_call_id: "old-tool", status: "success", tool_return: "output" },
      ],
      requestOtid: "accepted-request",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        retrieveMessage: async () => [{ run_id: "run-new" }],
        streamConversationMessages: async (
          _id: string,
          body: { otid: string },
        ) => {
          expect(body.otid).toBe("accepted-request");
          return {
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              yield { run_id: "run-new" };
            },
          };
        },
      } as never,
      resume: (async () => ({
        pendingApprovals: [
          {
            toolCallId: "new-tool",
            toolName: "Bash",
            toolArgs: "{}",
            messageId: "new-message",
          },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      setCwd: () => {},
      processTurn: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages?.[0]).toMatchObject({
      approvals: [{ tool_call_id: "new-tool", approve: false }],
    });
    expect(store.read("agent-1", "conv-1")?.requestOtid).not.toBe(
      "accepted-request",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("denial-only saved results restart with their exact request identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-denial-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  try {
    store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-old",
      toolCallIds: ["call-denied"],
      results: [
        {
          type: "approval",
          tool_call_id: "call-denied",
          approve: false,
          reason: "Listener restarted before approval",
        },
      ],
      requestOtid: "denial-request",
      workingDirectory: "/project",
    });
    await recoverRecordedTurns(listener, {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          { toolCallId: "call-denied", toolName: "Bash", toolArgs: "{}" },
        ],
      })) as never,
      canRecover: async () => true,
      acquireClaim: acquireTestClaim,
      setCwd: () => {},
      processTurn: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages?.[0]).toMatchObject({
      otid: "denial-request",
      approvals: [
        {
          tool_call_id: "call-denied",
          approve: false,
          reason: "Listener restarted before approval",
        },
      ],
    });
  } finally {
    listener.intentionallyClosed = true;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal delivery during the final ownership lookup keeps its newer work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-race-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  const record = {
    agentId: "agent-1",
    conversationId: "conv-1",
    runId: "run-old",
    toolCallIds: ["call-old"],
    results: [],
    requestOtid: "old-request",
    workingDirectory: "/project",
  };
  let checks = 0,
    sends = 0;
  try {
    store.write(record);
    await recoverRecordedTurns(listener, {
      store,
      backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
      resume: (async () => ({
        pendingApprovals: [
          { toolCallId: "call-old", toolName: "Bash", toolArgs: "{}" },
        ],
      })) as never,
      canRecover: async () => {
        if (++checks === 2) {
          getOrCreateScopedRuntime(
            listener,
            "agent-1",
            "conv-1",
          ).turnLifecycle.begin({
            origin: "message",
            workingDirectory: "/new",
          });
          store.write({ ...record, requestOtid: "new-request" });
        }
        return true;
      },
      processTurn: async () => {
        sends++;
      },
      setCwd: () => {},
    });
    expect(sends).toBe(0);
    expect(store.read("agent-1", "conv-1")?.requestOtid).toBe("new-request");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a tool generated while the listener was down is recovered only from its recorded run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-model-"));
  const store = createInterruptedTurnStore(directory);
  const runtime = createRuntime();
  runtime.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  const record = {
    agentId: "agent-1",
    conversationId: "conv-1",
    runId: "run-model",
    toolCallIds: [],
    results: [],
    requestOtid: "previous-request",
    workingDirectory: "/project",
  };
  let messageRunId = "run-model";
  const deps = {
    store,
    backend: {
      retrieveAgent: async () => ({ id: "agent-1" }),
      retrieveMessage: async () => [{ run_id: messageRunId }],
    } as never,
    resume: (async () => ({
      pendingApprovals: [
        {
          toolCallId: "call-new",
          toolName: "Bash",
          toolArgs: "{}",
          messageId: "message-new",
        },
      ],
    })) as never,
    canRecover: async () => true,
    acquireClaim: acquireTestClaim,
    processTurn: async (message: IncomingMessage) => {
      sent.push(message);
    },
    setCwd: () => {},
  };
  try {
    store.write(record);
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages?.[0]).toMatchObject({
      type: "approval",
      approvals: [{ tool_call_id: "call-new", approve: false }],
    });
    expect(store.read("agent-1", "conv-1")?.requestOtid).not.toBe(
      "previous-request",
    );
    store.write(record);
    messageRunId = "run-other-process";
    await Bun.sleep(1);
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(1);
    expect(store.read("agent-1", "conv-1")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart sends saved results with the same request identity, never an unrelated pending tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-recovery-"));
  const store = createInterruptedTurnStore(directory);
  const runtime = createRuntime();
  runtime.connectionId = "conn-replacement";
  const sent: IncomingMessage[] = [];
  const record = {
    agentId: "agent-1",
    conversationId: "conv-1",
    runId: "run-1",
    toolCallIds: ["call-1"],
    results: [
      {
        tool_call_id: "call-1",
        tool_return: "saved output",
        status: "success" as const,
      },
    ],
    requestOtid: "same-request",
    actingUserId: "user-original",
    workingDirectory: "/project",
    durableInputIdentities: [{ domain: "input" as const, id: "scheduled-1" }],
    terminalConsumerIds: ["slack:agent-1"],
  };
  let pendingId = "call-1";
  const deps = {
    store,
    backend: {
      retrieveAgent: async () => ({ id: "agent-1" }),
      streamConversationMessages: async () => ({
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          yield { message_type: "ping", run_id: "run-1" };
        },
      }),
    } as never,
    resume: (async () => ({
      pendingApprovals: [
        { toolCallId: pendingId, toolName: "Bash", toolArgs: "{}" },
      ],
    })) as never,
    canRecover: async () => true,
    acquireClaim: acquireTestClaim,
    processTurn: async (message: IncomingMessage) => {
      sent.push(message);
    },
    setCwd: () => {},
  };
  try {
    // Empty disk on a fresh/prewarmed machine cannot authorize a turn.
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(0);
    store.write(record);
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages).toEqual([
      { type: "approval", approvals: record.results, otid: "same-request" },
    ]);
    expect(sent[0]?.actingUserId).toBe("user-original");
    expect(sent[0]?.durableInputIdentities).toEqual(
      record.durableInputIdentities,
    );
    expect(sent[0]?.terminalConsumerIds).toEqual(record.terminalConsumerIds);
    expect(store.read("agent-1", "conv-1")).not.toBeNull();
    pendingId = "call-elsewhere";
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(1);
    expect(store.read("agent-1", "conv-1")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
