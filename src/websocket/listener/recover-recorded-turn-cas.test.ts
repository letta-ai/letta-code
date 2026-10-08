import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
  rememberInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { recoverRecordedTurns } from "./recover-recorded-turn";
import { setActiveRuntime } from "./runtime";

test("completed teleport CAS loss preserves and rearms its successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-teleport-cas-"));
  const realStore = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  setActiveRuntime(listener);
  let scans = 0;
  let statusChecks = 0;
  let replaced = false;
  try {
    realStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      toolCallIds: [],
      results: [],
      requestOtid: "request-old",
      workingDirectory: "/project",
      teleportId: "teleport-completed",
    });
    const store = {
      ...realStore,
      list: () => {
        scans += 1;
        return realStore.list();
      },
      remove: (...args: Parameters<typeof realStore.remove>) => {
        if (!replaced) {
          replaced = true;
          const current = realStore.read("agent-1", "conv-1");
          if (!current) throw new Error("expected current record");
          realStore.write({
            ...current,
            requestOtid: "request-successor",
            teleportId: "teleport-successor",
          });
        }
        return realStore.remove(...args);
      },
    };

    await recoverRecordedTurns(listener, {
      store,
      canRecover: async () => true,
      teleportStatus: (async () => {
        statusChecks += 1;
        return { status: statusChecks === 1 ? "completed" : "pending" };
      }) as never,
      retryDelayMs: 20,
    });

    expect(realStore.read("agent-1", "conv-1")?.requestOtid).toBe(
      "request-successor",
    );
    await Bun.sleep(5);
    expect(scans).toBe(1);
    for (let attempt = 0; attempt < 100 && scans < 2; attempt += 1) {
      await Bun.sleep(2);
    }
    expect(scans).toBe(2);
    expect(statusChecks).toBe(2);
    expect(realStore.read("agent-1", "conv-1")?.teleportId).toBe(
      "teleport-successor",
    );
  } finally {
    listener.intentionallyClosed = true;
    setActiveRuntime(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed teleport retirement CAS loss preserves and rearms its successor", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "recorded-failed-teleport-cas-"),
  );
  const realStore = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  setActiveRuntime(listener);
  let scans = 0;
  let statusChecks = 0;
  let replaced = false;
  try {
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    expect(
      rememberInputDisposition(
        runtime,
        teleportInputIdentity("teleport-failed"),
        "queued",
        {
          incoming: {
            type: "message",
            agentId: "agent-1",
            conversationId: "conv-1",
            messages: [{ role: "user", content: "resume" }],
          },
        },
      ),
    ).toBe(true);
    realStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/project",
      teleport: {
        teleportId: "teleport-failed",
        connectionId: "source",
        activeTurn: false,
        ready: true,
      },
    });
    const store = {
      ...realStore,
      list: () => {
        scans += 1;
        return realStore.list();
      },
      remove: (...args: Parameters<typeof realStore.remove>) => {
        if (!replaced) {
          replaced = true;
          const current = realStore.read("agent-1", "conv-1");
          if (!current) throw new Error("expected current record");
          realStore.write({
            ...current,
            runId: "run-successor",
            toolCallIds: ["call-successor"],
            results: [
              {
                tool_call_id: "call-successor",
                status: "success",
                tool_return: "successor-result",
              },
            ],
            requestOtid: "request-successor",
            teleport: {
              teleportId: "teleport-successor",
              connectionId: "successor",
              activeTurn: false,
              ready: true,
            },
          });
        }
        return realStore.remove(...args);
      },
    };

    await recoverRecordedTurns(listener, {
      store,
      canRecover: async () => true,
      teleportStatus: (async () => {
        statusChecks += 1;
        return { status: statusChecks === 1 ? "failed" : "pending" };
      }) as never,
      retryDelayMs: 20,
    });

    expect(realStore.read("agent-1", "conv-1")).toMatchObject({
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      requestOtid: "request-successor",
      teleport: { teleportId: "teleport-successor" },
    });
    await Bun.sleep(5);
    expect(scans).toBe(1);
    for (let attempt = 0; attempt < 100 && scans < 2; attempt += 1) {
      await Bun.sleep(2);
    }
    expect(scans).toBe(2);
    expect(statusChecks).toBe(2);
    expect(realStore.read("agent-1", "conv-1")).toMatchObject({
      runId: "run-successor",
      results: [{ tool_call_id: "call-successor" }],
      requestOtid: "request-successor",
      teleport: { teleportId: "teleport-successor" },
    });
  } finally {
    listener.intentionallyClosed = true;
    setActiveRuntime(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("empty-owned CAS loss preserves and rearms its successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recorded-empty-owned-cas-"));
  const realStore = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-replacement";
  setActiveRuntime(listener);
  let scans = 0;
  let successorChecks = 0;
  let replaced = false;
  try {
    realStore.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-old",
      toolCallIds: ["call-old"],
      results: [],
      requestOtid: "request-old",
      workingDirectory: "/project",
    });
    const store = {
      ...realStore,
      list: () => {
        scans += 1;
        return realStore.list();
      },
      remove: (...args: Parameters<typeof realStore.remove>) => {
        if (!replaced) {
          replaced = true;
          const current = realStore.read("agent-1", "conv-1");
          if (!current) throw new Error("expected current record");
          realStore.write({
            ...current,
            requestOtid: "request-successor",
            teleportId: "teleport-successor",
          });
        }
        return realStore.remove(...args);
      },
    };

    await recoverRecordedTurns(listener, {
      store,
      backend: {
        retrieveAgent: async () => ({ id: "agent-1" }),
        retrieveMessage: async () => [{ run_id: "run-other" }],
      } as never,
      resume: (async () => ({
        pendingApprovals: [
          {
            toolCallId: "call-unowned",
            toolName: "Bash",
            toolArgs: "{}",
            messageId: "message-unowned",
          },
        ],
      })) as never,
      canRecover: async () => true,
      teleportStatus: (async () => {
        successorChecks += 1;
        return { status: "pending" };
      }) as never,
      retryDelayMs: 20,
    });

    expect(realStore.read("agent-1", "conv-1")?.requestOtid).toBe(
      "request-successor",
    );
    await Bun.sleep(5);
    expect(scans).toBe(1);
    for (let attempt = 0; attempt < 100 && scans < 2; attempt += 1) {
      await Bun.sleep(2);
    }
    expect(scans).toBe(2);
    expect(successorChecks).toBe(1);
    expect(realStore.read("agent-1", "conv-1")?.teleportId).toBe(
      "teleport-successor",
    );
  } finally {
    listener.intentionallyClosed = true;
    setActiveRuntime(null);
    rmSync(directory, { recursive: true, force: true });
  }
});
