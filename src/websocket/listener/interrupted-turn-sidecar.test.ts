import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordListenerWorkRetriably,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { __recoveryLineageSidecarTestUtils } from "./recovery-lineage-sidecar";

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
        durableInputIdentities: [{ domain: "input", id: "input-successor" }],
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
          effectInputIdentities: predecessor.durableInputIdentities,
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
    const sidecarFile = readdirSync(directory).find((file) =>
      file.includes(".json.recovery-"),
    );
    if (!sidecarFile) throw new Error("missing retired sidecar");
    const legacy = JSON.parse(
      readFileSync(join(directory, sidecarFile), "utf8"),
    );
    delete legacy.retiredInterruptedRevision;
    delete legacy.retiredAuthorityRevision;
    delete legacy.retiredAt;
    writeFileSync(join(directory, sidecarFile), JSON.stringify(legacy), "utf8");
    const restarted = createInterruptedTurnStore(directory);
    expect(() => restarted.list()).not.toThrow();
    expect(
      restarted.readRecoverySnapshot("agent-test", "conv-test", lineageId),
    ).toBeNull();
    expect(
      restarted.readRetiredRecoveryAuthority(
        "agent-test",
        "conv-test",
        lineageId,
      ),
    ).toEqual({ interruptedRevision: legacy.sourceMainRevision });
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
      durableInputIdentities: [
        { domain: "input", id: `${agentId}-predecessor` },
      ],
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-predecessor"],
        effectInputIdentities: [
          { domain: "input", id: `${agentId}-predecessor` },
        ],
      },
    });
    const successor = store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        requestOtid: "request-successor",
        durableInputIdentities: [
          { domain: "input", id: `${agentId}-successor` },
        ],
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
          effectInputIdentities: predecessor.durableInputIdentities,
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
      store
        .listDurableInputOwnership()
        .find((entry) => entry.agentId === "agent-corrupt"),
    ).toEqual({
      agentId: "agent-corrupt",
      conversationId: "conv-test",
      durableInputIdentities: [
        { domain: "input", id: "agent-corrupt-successor" },
        { domain: "input", id: "agent-corrupt-predecessor" },
      ],
      quarantined: true,
    });
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

test("sidecar scavenging preserves evidence beside an unreadable main", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-sidecar-main-"));
  const store = createInterruptedTurnStore(directory);
  try {
    const predecessor = store.write({
      agentId: "agent-corrupt-main",
      conversationId: "conv-test",
      runId: "run-predecessor",
      toolCallIds: ["call-predecessor"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
      recoveryClaimCompletion: {
        lineageId: "lineage-corrupt-main",
        state: "running",
        effectToolCallIds: ["call-predecessor"],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        recoveryClaimCompletion: {
          lineageId: "lineage-corrupt-main",
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: predecessor.toolCallIds,
          effectInputIdentities: predecessor.durableInputIdentities,
        },
      },
      predecessor.revision,
    );
    store.writeRecoveryLineageSnapshot({
      agentId: "agent-corrupt-main",
      conversationId: "conv-test",
      lineageId: "lineage-corrupt-main",
      update: { results: [] },
    });
    const files = readdirSync(directory);
    const main = files.find(
      (file) =>
        file.startsWith("agent-corrupt-main_") && file.endsWith(".json"),
    );
    const sidecar = files.find(
      (file) =>
        file.startsWith("agent-corrupt-main_") &&
        file.includes(".json.recovery-"),
    );
    if (!main || !sidecar) throw new Error("missing sidecar fixture");
    writeFileSync(join(directory, main), "{truncated", "utf8");
    expect(store.list()).toEqual([]);
    expect(() =>
      store.readRecoverySnapshot(
        "agent-corrupt-main",
        "conv-test",
        "lineage-corrupt-main",
      ),
    ).toThrow("authority is unreadable");
    expect(readdirSync(directory)).toContain(sidecar);
    expect(store.listDurableInputOwnership()).toEqual([
      {
        agentId: "agent-corrupt-main",
        conversationId: "conv-test",
        durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
        quarantined: true,
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable ordinary main quarantines its full scope without a sidecar", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-corrupt-ordinary-"));
  const store = createInterruptedTurnStore(directory);
  try {
    store.write({
      agentId: "agent-corrupt-ordinary",
      conversationId: "conv-test",
      runId: "run-corrupt-ordinary",
      toolCallIds: [],
      results: [],
      requestOtid: "request-corrupt-ordinary",
      workingDirectory: "/corrupt-ordinary",
      durableInputIdentities: [
        { domain: "input", id: "input-corrupt-ordinary" },
      ],
    });
    const main = readdirSync(directory).find(
      (file) =>
        file.startsWith("agent-corrupt-ordinary_") && file.endsWith(".json"),
    );
    if (!main) throw new Error("missing ordinary main fixture");
    writeFileSync(join(directory, main), "{truncated", "utf8");

    expect(store.listDurableInputOwnership()).toEqual([
      {
        agentId: "agent-corrupt-ordinary",
        conversationId: "conv-test",
        durableInputIdentities: [],
        quarantined: true,
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dual main and sidecar corruption still quarantines the canonical scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-dual-corrupt-"));
  const store = createInterruptedTurnStore(directory);
  try {
    const predecessor = store.write({
      agentId: "agent-dual-corrupt",
      conversationId: "conv-test",
      runId: "run-dual-corrupt",
      toolCallIds: [],
      results: [],
      requestOtid: "request-dual-corrupt",
      workingDirectory: "/dual-corrupt",
      recoveryClaimCompletion: {
        lineageId: "lineage-dual-corrupt",
        state: "running",
        effectToolCallIds: [],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-dual-successor",
        recoveryClaimCompletion: {
          lineageId: "lineage-dual-corrupt",
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: [],
        },
      },
      predecessor.revision,
    );
    store.writeRecoveryLineageSnapshot({
      agentId: predecessor.agentId,
      conversationId: predecessor.conversationId,
      lineageId: "lineage-dual-corrupt",
      update: {
        durableInputIdentities: [{ domain: "input", id: "input-sidecar" }],
      },
    });
    const files = readdirSync(directory);
    const main = files.find(
      (file) =>
        file.startsWith("agent-dual-corrupt_") && file.endsWith(".json"),
    );
    const sidecar = files.find(
      (file) =>
        file.startsWith("agent-dual-corrupt_") &&
        file.includes(".json.recovery-"),
    );
    if (!main || !sidecar) throw new Error("missing dual corruption fixture");
    writeFileSync(join(directory, main), "{truncated", "utf8");
    writeFileSync(join(directory, sidecar), "{truncated", "utf8");

    expect(store.listDurableInputOwnership()).toEqual([
      {
        agentId: "agent-dual-corrupt",
        conversationId: "conv-test",
        durableInputIdentities: [],
        quarantined: true,
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readable successor ownership includes post-fork sidecar inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-sidecar-ownership-"));
  const store = createInterruptedTurnStore(directory);
  try {
    const predecessor = store.write({
      agentId: "agent-sidecar-ownership",
      conversationId: "conv-test",
      runId: "run-predecessor",
      toolCallIds: [],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
      recoveryClaimCompletion: {
        lineageId: "lineage-sidecar-ownership",
        state: "running",
        effectToolCallIds: [],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-successor",
        durableInputIdentities: [{ domain: "input", id: "input-successor" }],
        recoveryClaimCompletion: {
          lineageId: "lineage-sidecar-ownership",
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: [],
          effectInputIdentities: predecessor.durableInputIdentities,
        },
      },
      predecessor.revision,
    );
    store.writeRecoveryLineageSnapshot({
      agentId: predecessor.agentId,
      conversationId: predecessor.conversationId,
      lineageId: "lineage-sidecar-ownership",
      update: {
        durableInputIdentities: [{ domain: "input", id: "input-post-fork" }],
      },
    });

    expect(store.listDurableInputOwnership()).toEqual([
      {
        agentId: "agent-sidecar-ownership",
        conversationId: "conv-test",
        durableInputIdentities: [
          { domain: "input", id: "input-successor" },
          { domain: "input", id: "input-predecessor" },
          { domain: "input", id: "input-post-fork" },
        ],
        quarantined: false,
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sidecar enumeration removes stale crash-left temporary files", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-sidecar-temp-"));
  const store = createInterruptedTurnStore(directory);
  try {
    const record = store.write({
      agentId: "agent.recovery-temp",
      conversationId: "conv-test",
      runId: "run-temp",
      toolCallIds: [],
      results: [],
      requestOtid: "request-temp",
      workingDirectory: "/temp",
      recoveryClaimCompletion: {
        lineageId: "lineage-temp",
        state: "running",
        independentSuccessor: true,
        effectRevision: "revision-predecessor",
        effectToolCallIds: [],
      },
    });
    store.writeRecoveryLineageSnapshot({
      agentId: record.agentId,
      conversationId: record.conversationId,
      lineageId: "lineage-temp",
      update: { results: [] },
    });
    const canonical = readdirSync(directory).find((file) =>
      file.includes(".json.recovery-"),
    );
    if (!canonical) throw new Error("missing canonical sidecar");
    const temporary = `${canonical}.2147483647.00000000-0000-4000-8000-000000000000.tmp`;
    const liveTemporary = `${canonical}.${process.pid}.${__recoveryLineageSidecarTestUtils.sidecarWriterInstanceId}.00000000-0000-4000-8000-000000000001.tmp`;
    const reusedPidTemporary = `${canonical}.${process.pid}.00000000-0000-4000-8000-000000000002.00000000-0000-4000-8000-000000000003.tmp`;
    copyFileSync(join(directory, canonical), join(directory, temporary));
    copyFileSync(join(directory, canonical), join(directory, liveTemporary));
    copyFileSync(
      join(directory, canonical),
      join(directory, reusedPidTemporary),
    );
    const stale = new Date(Date.now() - 120_000);
    const abandoned = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(join(directory, temporary), stale, stale);
    utimesSync(join(directory, liveTemporary), abandoned, abandoned);
    utimesSync(join(directory, reusedPidTemporary), abandoned, abandoned);

    store.list();
    expect(readdirSync(directory)).toContain(canonical);
    expect(readdirSync(directory)).not.toContain(temporary);
    expect(readdirSync(directory)).toContain(liveTemporary);
    expect(readdirSync(directory)).not.toContain(reusedPidTemporary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
