import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import type { IncomingMessage } from "./types";

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
    workingDirectory: "/project",
  };
  let pendingId = "call-1";
  const deps = {
    store,
    backend: { retrieveAgent: async () => ({ id: "agent-1" }) } as never,
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
    expect(store.read("agent-1", "conv-1")).not.toBeNull();
    pendingId = "call-elsewhere";
    await recoverRecordedTurns(runtime, deps);
    expect(sent).toHaveLength(1);
    expect(store.read("agent-1", "conv-1")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
