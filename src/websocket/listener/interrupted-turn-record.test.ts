import { expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { acquireDurableFileLock } from "./durable-file-lock";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordedToolResults,
  recordListenerWork,
  recordListenerWorkRetriably,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { retireAcknowledgedRecoveryClaim } from "./recovery-claim-completion";

test("retryable listener checkpoint outlives a live holder beyond two seconds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-live-holder-"));
  const store = createInterruptedTurnStore(directory, { lockWaitMs: 25 });
  const listener = createRuntime();
  listener.connectionId = "conn-live-holder";
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-live-holder",
    "conv-live-holder",
  );
  const destination = join(
    directory,
    `${encodeURIComponent("agent-live-holder")}_${encodeURIComponent("conv-live-holder")}.json`,
  );
  const release = acquireDurableFileLock(destination);
  const started = performance.now();
  const releaseTimer = setTimeout(release, 2_100);
  try {
    const revision = await recordListenerWorkRetriably(
      runtime,
      { runId: "run-after-holder" },
      "run_observed",
      undefined,
      undefined,
      { store, retryDelayMs: 5 },
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(revision).toBeString();
    expect(store.read("agent-live-holder", "conv-live-holder")?.runId).toBe(
      "run-after-holder",
    );
  } finally {
    clearTimeout(releaseTimer);
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { name: "missing approvals", continuation: {} },
  { name: "non-array approvals", continuation: { approvals: "invalid" } },
  {
    name: "malformed approval",
    continuation: { approvals: [{ status: "success", tool_return: "ok" }] },
  },
  {
    name: "malformed content part",
    continuation: {
      approvals: [
        {
          tool_call_id: "call-1",
          status: "success",
          tool_return: [{ type: "image", source: { type: "base64" } }],
        },
      ],
    },
  },
])("rejects persisted teleport continuation with $name", ({ continuation }) => {
  const directory = mkdtempSync(join(tmpdir(), "listener-invalid-teleport-"));
  try {
    writeFileSync(
      join(directory, "agent-test_conv-test.json"),
      JSON.stringify({
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: "run-test",
        toolCallIds: [],
        results: [],
        requestOtid: "request-test",
        workingDirectory: "/project",
        teleport: {
          teleportId: "teleport-test",
          connectionId: "source",
          activeTurn: true,
          ready: true,
          continuation,
        },
      }),
    );
    expect(
      createInterruptedTurnStore(directory).read("agent-test", "conv-test"),
    ).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["direct", "detached"])(
  "%s recovery completion preserves an independent successor write",
  (path) => {
    const directory = mkdtempSync(join(tmpdir(), "listener-successor-"));
    const store = createInterruptedTurnStore(directory);
    const listener = createRuntime();
    listener.connectionId = "conn-successor";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-test",
      "conv-test",
    );
    const lineageId = "recovery-lineage";
    try {
      const running = store.write({
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: "run-predecessor",
        toolCallIds: ["call-predecessor"],
        results: [],
        requestOtid: "request-predecessor",
        workingDirectory: "/predecessor",
        durableInputIdentities: [{ domain: "input", id: "input-predecessor" }],
        recoveryClaimCompletion: { lineageId, state: "running" },
      });
      const pendingRevision =
        path === "direct"
          ? recordListenerWork(
              runtime,
              {
                recoveryClaimCompletion: {
                  lineageId,
                  state: "pending",
                  effectRevision: running.revision,
                },
              },
              "after_tool_execution",
              running.revision,
              lineageId,
              store,
            )
          : store.write(
              {
                ...running,
                recoveryClaimCompletion: {
                  lineageId,
                  state: "pending",
                  effectRevision: running.revision,
                },
              },
              running.revision,
            ).revision;
      expect(pendingRevision).toBeString();

      const successorRevision = recordListenerWork(
        runtime,
        {
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
          actingUserId: "actor-successor",
          durableInputIdentities: [{ domain: "input", id: "input-successor" }],
          terminalConsumerIds: ["slack:agent-test"],
        },
        "after_tool_execution",
        pendingRevision,
        undefined,
        store,
      );
      expect(successorRevision).toBeString();
      expect(
        store.read("agent-test", "conv-test")?.recoveryClaimCompletion,
      ).toMatchObject({
        lineageId,
        independentSuccessor: true,
        effectInputIdentities: [{ domain: "input", id: "input-predecessor" }],
      });

      expect(
        retireAcknowledgedRecoveryClaim(store, {
          agentId: "agent-test",
          conversationId: "conv-test",
          lineageId,
          pendingRevision: pendingRevision ?? "missing",
        }),
      ).toBe("preserved");
      const retiredSuccessor = store.read("agent-test", "conv-test");
      expect(retiredSuccessor?.revision).toBeString();
      expect(retiredSuccessor?.revision).not.toBe(successorRevision);
      if (!retiredSuccessor) throw new Error("expected retired successor");
      expect(() =>
        store.write(
          {
            ...retiredSuccessor,
            recoveryClaimCompletion: {
              lineageId,
              state: "pending",
              effectRevision: running.revision,
              independentSuccessor: true,
            },
            requestOtid: "stale-overwrite",
          },
          successorRevision,
        ),
      ).toThrow("Interrupted-turn revision changed");
      expect(store.read("agent-test", "conv-test")?.requestOtid).toBe(
        "request-successor",
      );
      expect(
        store.read("agent-test", "conv-test")?.recoveryClaimCompletion,
      ).toBeUndefined();
      const successorCheckpoint = recordListenerWork(
        runtime,
        { terminalConsumerIds: ["slack:agent-test"] },
        "after_tool_execution",
        retiredSuccessor?.revision,
        undefined,
        store,
      );
      expect(successorCheckpoint).toBeString();
      expect(store.read("agent-test", "conv-test")).toMatchObject({
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        results: [{ tool_call_id: "call-successor" }],
        requestOtid: "request-successor",
        actingUserId: "actor-successor",
        durableInputIdentities: [{ domain: "input", id: "input-successor" }],
        terminalConsumerIds: ["slack:agent-test"],
      });
      expect(
        store.read("agent-test", "conv-test")?.recoveryClaimCompletion,
      ).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("matching continuation identity consumes only its inherited teleport intent", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-teleport-owner-"));
  const store = createInterruptedTurnStore(directory);
  const listener = createRuntime();
  listener.connectionId = "conn-successor";
  const runtime = getOrCreateScopedRuntime(listener, "agent-test", "conv-test");
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
        teleportId: "teleport-exact",
        connectionId: "source",
        activeTurn: false,
        ready: true,
      },
    });
    const unrelatedRevision = recordListenerWork(
      runtime,
      { runId: "run-unrelated" },
      "run_observed",
      predecessor.revision,
      undefined,
      store,
    );
    expect(store.read("agent-test", "conv-test")?.teleport?.teleportId).toBe(
      "teleport-exact",
    );
    const differentRevision = recordListenerWork(
      runtime,
      {
        durableInputIdentities: [
          { domain: "teleport", id: "teleport-different" },
        ],
      },
      "run_observed",
      unrelatedRevision,
      undefined,
      store,
    );
    expect(store.read("agent-test", "conv-test")?.teleport?.teleportId).toBe(
      "teleport-exact",
    );
    recordListenerWork(
      runtime,
      {
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
        durableInputIdentities: [{ domain: "teleport", id: "teleport-exact" }],
      },
      "after_tool_execution",
      differentRevision,
      undefined,
      store,
    );
    expect(store.read("agent-test", "conv-test")).toMatchObject({
      runId: "run-successor",
      toolCallIds: ["call-successor"],
      results: [{ tool_call_id: "call-successor" }],
      requestOtid: "request-successor",
      durableInputIdentities: [{ domain: "teleport", id: "teleport-exact" }],
    });
    expect(store.read("agent-test", "conv-test")?.teleport).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("round-trips persisted teleport text and image ToolReturn parts", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-teleport-parts-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const written = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: null,
      toolCallIds: [],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
      teleport: {
        teleportId: "teleport-test",
        connectionId: "source",
        activeTurn: true,
        ready: true,
        continuation: {
          approvals: [
            {
              tool_call_id: "call-1",
              status: "success",
              tool_return: [
                { type: "text", text: "done" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "aW1hZ2U=",
                  },
                },
              ],
            },
          ],
        },
      },
    } as InterruptedTurnRecord);
    expect(store.read("agent-test", "conv-test")).toEqual(written);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { name: "null", actingUserId: null },
  { name: "number", actingUserId: 42 },
  { name: "object", actingUserId: {} },
  { name: "array", actingUserId: [] },
])("rejects persisted $name actingUserId", ({ actingUserId }) => {
  const directory = mkdtempSync(join(tmpdir(), "listener-invalid-actor-"));
  try {
    writeFileSync(
      join(directory, "agent-test_conv-test.json"),
      JSON.stringify({
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: null,
        toolCallIds: [],
        results: [],
        requestOtid: "request-test",
        workingDirectory: "/project",
        actingUserId,
      }),
    );
    expect(
      createInterruptedTurnStore(directory).read("agent-test", "conv-test"),
    ).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { lineageId: "", state: "pending", effectRevision: "revision-1" },
  { lineageId: "lineage-1", state: "unknown" },
  { lineageId: "lineage-1", state: "pending" },
  { lineageId: "lineage-1", state: "pending", effectRevision: 42 },
])("rejects malformed recovery claim completion marker %#", (marker) => {
  const directory = mkdtempSync(
    join(tmpdir(), "listener-invalid-claim-marker-"),
  );
  try {
    writeFileSync(
      join(directory, "agent-test_conv-test.json"),
      JSON.stringify({
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: null,
        toolCallIds: [],
        results: [],
        requestOtid: "request-test",
        workingDirectory: "/project",
        recoveryClaimCompletion: marker,
      }),
    );
    expect(
      createInterruptedTurnStore(directory).read("agent-test", "conv-test"),
    ).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a queued unattributed user clears inherited actor in restart evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-actor-clear-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const first = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: null,
      toolCallIds: [],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
      actingUserId: "user-a",
    });
    store.write({ ...first, actingUserId: undefined }, first.revision);
    expect(store.read("agent-test", "conv-test")?.actingUserId).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([undefined, "user-1"])(
  "accepts persisted actingUserId %p",
  (actingUserId) => {
    const directory = mkdtempSync(join(tmpdir(), "listener-valid-actor-"));
    try {
      const store = createInterruptedTurnStore(directory);
      const written = store.write({
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: null,
        toolCallIds: [],
        results: [],
        requestOtid: "request-test",
        workingDirectory: "/project",
        actingUserId,
      });
      expect(store.read("agent-test", "conv-test")).toEqual(written);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("fsyncs the parent after publishing and removing a checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-fsync-"));
  try {
    const observations: Array<"present" | "absent"> = [];
    let store!: ReturnType<typeof createInterruptedTurnStore>;
    const syncDirectory = mock((syncedDirectory: string) => {
      expect(syncedDirectory).toBe(directory);
      observations.push(
        store.read("agent-test", "conv-test") ? "present" : "absent",
      );
    });
    store = createInterruptedTurnStore(directory, {
      fsyncDirectory: syncDirectory,
    });
    store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-test",
      toolCallIds: ["call-test"],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
    });
    store.remove("agent-test", "conv-test");

    expect(observations).toEqual(["present", "absent"]);
    expect(syncDirectory).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retains checkpoint evidence when removal fsync fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-fsync-failure-"));
  try {
    let syncCount = 0;
    const store = createInterruptedTurnStore(directory, {
      fsyncDirectory: () => {
        syncCount += 1;
        if (syncCount >= 2) throw new Error("directory fsync failed");
      },
    });
    store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-test",
      toolCallIds: ["call-test"],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
    });

    expect(() => store.remove("agent-test", "conv-test")).toThrow(
      "directory fsync failed",
    );
    expect(store.read("agent-test", "conv-test")).not.toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not fsync when removing a checkpoint that does not exist", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-fsync-missing-"));
  try {
    const syncDirectory = mock(() => {});
    createInterruptedTurnStore(directory, {
      fsyncDirectory: syncDirectory,
    }).remove("agent-test", "conv-test");
    expect(syncDirectory).not.toHaveBeenCalled();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revision snapshots cannot recreate any retired generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-retired-revision-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const first = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-first",
      toolCallIds: [],
      results: [],
      requestOtid: "request-first",
      workingDirectory: "/project",
    });
    expect(store.remove("agent-test", "conv-test", first.revision)).toBe(true);

    const second = store.write({
      ...first,
      revision: undefined,
      runId: "run-second",
      requestOtid: "request-second",
    });
    expect(store.remove("agent-test", "conv-test", second.revision)).toBe(true);

    expect(() => store.write(first)).toThrow("cannot recreate a record");
    expect(() => store.write(first, first.revision)).toThrow(
      "cannot recreate a record",
    );
    expect(() => store.write(second)).toThrow("cannot recreate a record");
    expect(() => store.write(second, null)).toThrow("cannot recreate a record");

    const fresh = store.write({
      ...second,
      revision: undefined,
      runId: "run-fresh",
      requestOtid: "request-fresh",
    });
    expect(fresh.runId).toBe("run-fresh");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retirements leave no per-scope tombstones or inode growth", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-retirement-bounded-"));
  try {
    const store = createInterruptedTurnStore(directory);
    for (let index = 0; index < 50; index += 1) {
      const agentId = `agent-${index}`;
      const conversationId = `conversation-${index}`;
      const record = store.write({
        agentId,
        conversationId,
        runId: `run-${index}`,
        toolCallIds: [],
        results: [],
        requestOtid: `request-${index}`,
        workingDirectory: "/project",
      });
      expect(store.remove(agentId, conversationId, record.revision)).toBe(true);
    }
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale owners cannot overwrite or remove a successor checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-revision-cas-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const first = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-first",
      toolCallIds: ["call-test"],
      results: [],
      requestOtid: "request-first",
      workingDirectory: "/project",
    });
    const successor = store.write(
      { ...first, runId: "run-successor", requestOtid: "request-successor" },
      first.revision,
    );

    expect(() =>
      store.write({ ...first, results: [] }, first.revision),
    ).toThrow("Interrupted-turn revision changed");
    expect(store.remove("agent-test", "conv-test", first.revision)).toBe(false);
    expect(store.read("agent-test", "conv-test")?.revision).toBe(
      successor.revision,
    );
    expect(store.remove("agent-test", "conv-test", successor.revision)).toBe(
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a replacement reads completed results; another sandbox has nothing to recover", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-restart-"));
  try {
    const store = createInterruptedTurnStore(join(directory, "original"));
    const record: InterruptedTurnRecord = {
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-test",
      toolCallIds: ["call-test"],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
    };
    store.write(record);
    expect(recordedToolResults(record, ["call-test"])[0]).toMatchObject({
      type: "approval",
      tool_call_id: "call-test",
      approve: false,
    });
    writeFileSync(
      join(directory, "original", "agent-bad_conv-bad.json"),
      "{broken",
    );
    expect(store.read("agent-bad", "conv-bad")).toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(
      createInterruptedTurnStore(join(directory, "prewarm")).read(
        "agent-test",
        "conv-test",
      ),
    ).toBeNull();
    const result = {
      tool_call_id: "call-test",
      tool_return: "completed output",
      status: "success" as const,
    };
    store.write({ ...record, results: [result] });
    const replacement = createInterruptedTurnStore(join(directory, "original"));
    expect(replacement.read("agent-test", "conv-test")?.results).toEqual([
      result,
    ]);
    expect(replacement.read("agent-test", "conv-other")).toBeNull();
    replacement.remove("agent-test", "conv-test");
    expect(store.read("agent-test", "conv-test")).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
