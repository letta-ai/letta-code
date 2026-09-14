import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";

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

import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import type { IncomingMessage } from "./types";

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
    expect(store.read("agent-1", "conv-1")).not.toBeNull();
    pendingId = "call-elsewhere";
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(1);
    expect(store.read("agent-1", "conv-1")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
