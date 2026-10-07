import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordListenerWorkRetriably,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";

test("a pre-effect rollback retries into a racing successor sidecar", async () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-effect-rollback-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const listener = createRuntime();
    listener.connectionId = "conn-test";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-test",
      "conv-test",
    );
    const lineageId = "lineage-rollback";
    const predecessor = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-predecessor",
      toolCallIds: ["call-started", "call-unstarted"],
      unstartedToolCallIds: ["call-started", "call-unstarted"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-started", "call-unstarted"],
      },
    });
    const successorRecord: InterruptedTurnRecord = {
      ...predecessor,
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      results: [
        {
          type: "tool",
          tool_call_id: "call-successor",
          tool_return: "successor-result",
          status: "success",
        },
      ],
      requestOtid: "request-successor",
      recoveryClaimCompletion: {
        ...predecessor.recoveryClaimCompletion,
        lineageId,
        state: "running",
        independentSuccessor: true,
        effectRevision: predecessor.revision,
        effectRunId: predecessor.runId,
        effectRequestOtid: predecessor.requestOtid,
        effectWorkingDirectory: predecessor.workingDirectory,
        effectResults: predecessor.results,
        effectUnstartedToolCallIds: predecessor.unstartedToolCallIds,
      },
    };
    let successorRevision: string | undefined;
    let racePending = true;
    const racingStore: typeof store = {
      ...store,
      read(agentId, conversationId) {
        const observed = store.read(agentId, conversationId);
        if (racePending) {
          racePending = false;
          successorRevision = store.write(
            successorRecord,
            predecessor.revision,
          ).revision;
        }
        return observed;
      },
    };

    const rollbackRevision = await recordListenerWorkRetriably(
      runtime,
      {
        toolCallIds: ["call-started", "call-unstarted", "call-later"],
        results: [],
        unstartedToolCallIds: ["call-started", "call-unstarted", "call-later"],
      },
      "before_tool_execution",
      predecessor.revision,
      lineageId,
      { store: racingStore, retryDelayMs: 1 },
    );
    expect(rollbackRevision).toBe(
      store.readRecoverySnapshot("agent-test", "conv-test", lineageId)
        ?.revisionToken,
    );
    if (!successorRevision) throw new Error("expected successor revision");

    const main = store.read("agent-test", "conv-test");
    expect(main?.revision).toBe(successorRevision);
    expect(main).toMatchObject({
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      results: [{ tool_call_id: "call-successor" }],
    });
    expect(
      store.readRecoveryView("agent-test", "conv-test", lineageId),
    ).toMatchObject({
      runId: "run-predecessor",
      toolCallIds: ["call-started", "call-unstarted", "call-later"],
      results: [],
      unstartedToolCallIds: ["call-started", "call-unstarted", "call-later"],
    });
    const checkpoint = store.write(
      { ...(store.read("agent-test", "conv-test") as InterruptedTurnRecord) },
      successorRevision,
    );
    expect(checkpoint.revision).not.toBe(successorRevision);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sidecar rollback replaces unknown snapshots without erasing exact settlements", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-sidecar-results-"));
  const store = createInterruptedTurnStore(directory);
  const lineageId = "lineage-results";
  try {
    const unknown = {
      type: "approval" as const,
      tool_call_id: "call-unknown",
      approve: false,
      reason: "outcome unknown",
    };
    const predecessor = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-predecessor",
      toolCallIds: ["call-unknown", "call-exact"],
      results: [unknown],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-unknown", "call-exact"],
      },
    });
    const successor = store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        results: [],
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectRunId: predecessor.runId,
          effectToolCallIds: predecessor.toolCallIds,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
        },
      },
      predecessor.revision,
    );
    store.mergeSettledRecoveryResult({
      agentId: "agent-test",
      conversationId: "conv-test",
      lineageId,
      result: {
        type: "tool",
        tool_call_id: "call-exact",
        tool_return: "exact",
        status: "success",
      },
    });
    store.writeRecoveryLineageSnapshot({
      agentId: "agent-test",
      conversationId: "conv-test",
      lineageId,
      update: {
        results: [],
        unstartedToolCallIds: ["call-unknown", "call-exact"],
      },
    });

    expect(store.read("agent-test", "conv-test")?.revision).toBe(
      successor.revision,
    );
    expect(
      store.readRecoveryView("agent-test", "conv-test", lineageId),
    ).toMatchObject({
      results: [
        {
          tool_call_id: "call-exact",
          tool_return: "exact",
          status: "success",
        },
      ],
      unstartedToolCallIds: ["call-unknown"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["rewrite", "remove"] as const)(
  "first run checkpoint reconciles a predecessor %s race",
  async (race) => {
    const directory = mkdtempSync(join(tmpdir(), `listener-first-${race}-`));
    const store = createInterruptedTurnStore(directory);
    const listener = createRuntime();
    listener.connectionId = "conn-successor";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-test",
      "conv-test",
    );
    try {
      const predecessor = store.write({
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: "run-predecessor",
        toolCallIds: ["call-predecessor"],
        results: [],
        requestOtid: "request-predecessor",
        workingDirectory: "/predecessor",
      });
      let racePending = true;
      const racingStore: typeof store = {
        ...store,
        read(agentId, conversationId) {
          const observed = store.read(agentId, conversationId);
          if (racePending) {
            racePending = false;
            if (race === "rewrite") {
              store.write(
                {
                  ...(observed as InterruptedTurnRecord),
                  results: [
                    {
                      type: "tool",
                      tool_call_id: "call-predecessor",
                      tool_return: "exact",
                      status: "success",
                    },
                  ],
                },
                predecessor.revision,
              );
            } else {
              store.remove(agentId, conversationId, predecessor.revision);
            }
          }
          return observed;
        },
      };

      await recordListenerWorkRetriably(
        runtime,
        {
          runId: "run-successor",
          durableInputIdentities: [{ domain: "input", id: "input-successor" }],
        },
        "run_observed",
        predecessor.revision,
        undefined,
        { store: racingStore, retryDelayMs: 1 },
      );
      expect(store.read("agent-test", "conv-test")).toMatchObject({
        runId: "run-successor",
        durableInputIdentities: [{ domain: "input", id: "input-successor" }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("retired predecessor sidecar clears its inherited teleport without deleting the successor", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-sidecar-teleport-"));
  const store = createInterruptedTurnStore(directory);
  const lineageId = "lineage-teleport";
  try {
    const predecessor = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      teleport: {
        teleportId: "teleport-predecessor",
        connectionId: "source",
        activeTurn: false,
        ready: true,
      },
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: predecessor.toolCallIds,
          effectRunId: predecessor.runId,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
          effectTeleport: predecessor.teleport,
        },
      },
      predecessor.revision,
    );
    const pending = store.markRecoveryClaimCompletionPending({
      agentId: "agent-test",
      conversationId: "conv-test",
      lineageId,
      expectedRevision: store.readRecoverySnapshot(
        "agent-test",
        "conv-test",
        lineageId,
      )?.revisionToken as string,
    });
    expect(pending?.revision).toBeString();
    expect(
      store.retireRecoveryClaimCompletion({
        agentId: "agent-test",
        conversationId: "conv-test",
        lineageId,
        pendingRevision: pending?.revision as string,
      }),
    ).toBe("preserved");
    expect(store.read("agent-test", "conv-test")).toMatchObject({
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      teleport: undefined,
      recoveryClaimCompletion: undefined,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("list isolates malformed sidecars and scavenges their orphan files", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-sidecar-list-"));
  const store = createInterruptedTurnStore(directory);
  const writeIndependent = (agentId: string, lineageId: string) => {
    const predecessor = store.write({
      agentId,
      conversationId: "conv-test",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    const successor = store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: predecessor.toolCallIds,
          effectRunId: predecessor.runId,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
        },
      },
      predecessor.revision,
    );
    store.writeRecoveryLineageSnapshot({
      agentId,
      conversationId: "conv-test",
      lineageId,
      update: { results: [] },
    });
    return successor;
  };
  try {
    writeIndependent("agent-corrupt", "lineage-corrupt");
    const corruptOrphan = writeIndependent(
      "agent-corrupt-orphan",
      "lineage-corrupt-orphan",
    );
    const invalidOrphan = writeIndependent(
      "agent-invalid-orphan",
      "lineage-invalid-orphan",
    );
    const orphan = writeIndependent("agent-orphan", "lineage-orphan");
    store.write({
      agentId: "agent-healthy",
      conversationId: "conv-test",
      runId: "run-healthy",
      toolCallIds: [],
      results: [],
      requestOtid: "request-healthy",
      workingDirectory: "/healthy",
    });
    const sidecars = readdirSync(directory).filter((file) =>
      file.includes(".json.recovery-"),
    );
    const corruptPath = sidecars.find((file) =>
      file.startsWith("agent-corrupt_"),
    );
    const corruptOrphanPath = sidecars.find((file) =>
      file.startsWith("agent-corrupt-orphan_"),
    );
    const invalidOrphanPath = sidecars.find((file) =>
      file.startsWith("agent-invalid-orphan_"),
    );
    if (!corruptPath) throw new Error("missing corrupt sidecar fixture");
    if (!corruptOrphanPath || !invalidOrphanPath)
      throw new Error("missing malformed orphan sidecar fixture");
    writeFileSync(join(directory, corruptPath), "{truncated", "utf8");
    writeFileSync(join(directory, corruptOrphanPath), "{truncated", "utf8");
    writeFileSync(join(directory, invalidOrphanPath), "{}", "utf8");
    expect(
      store.remove("agent-corrupt-orphan", "conv-test", corruptOrphan.revision),
    ).toBe(true);
    expect(
      store.remove("agent-invalid-orphan", "conv-test", invalidOrphan.revision),
    ).toBe(true);
    expect(store.remove("agent-orphan", "conv-test", orphan.revision)).toBe(
      true,
    );

    expect(store.list().map((record) => record.agentId)).toEqual([
      "agent-healthy",
    ]);
    expect(
      readdirSync(directory).filter(
        (file) =>
          (file.startsWith("agent-orphan_") ||
            file.startsWith("agent-corrupt-orphan_") ||
            file.startsWith("agent-invalid-orphan_")) &&
          file.includes(".json.recovery-"),
      ),
    ).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
