import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { acquireDurableFileLock } from "./durable-file-lock";
import {
  allRecordedResults,
  createInterruptedTurnStore,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import {
  createRecoveryEvidenceCheckpoint,
  createStoreBoundRecoveryEvidenceWriter,
  mergeSettledRecoveryResultRetriably,
} from "./recovery-evidence";

test("custom recovery authority tokens require a matching store", async () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const evidence = createRecoveryEvidenceCheckpoint(
    runtime,
    () => "custom-authority-revision",
    "revision-observed",
  );
  await expect(
    evidence.write({ results: [] }, "before_tool_execution"),
  ).rejects.toThrow(
    "Custom recovery authority token requires matching authority store",
  );
});

test("post-effect recovery checkpoints survive lock contention and authority loss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-evidence-lock-"));
  try {
    const store = createInterruptedTurnStore(directory, { lockWaitMs: 10 });
    const listener = createRuntime();
    listener.connectionId = "conn-test";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-test",
      "conv-test",
    );
    const initial = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-test",
      toolCallIds: ["call-test"],
      unstartedToolCallIds: [],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
    });
    const release = acquireDurableFileLock(
      join(directory, "agent-test_conv-test.json"),
      { waitMs: 10 },
    );
    let authoritative = true;
    const timer = setTimeout(() => {
      authoritative = false;
      release();
    }, 100);
    const writer = createStoreBoundRecoveryEvidenceWriter(
      store,
      () => authoritative,
    );
    const revision = await writer(
      runtime,
      { results: [] },
      "after_tool_execution",
      initial.revision,
    );
    clearTimeout(timer);
    expect(revision).toBeString();
    expect(revision).not.toBe(initial.revision);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-effect recovery checkpoints stop after authority loss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-evidence-fence-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const listener = createRuntime();
    listener.connectionId = "conn-test";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-test",
      "conv-test",
    );
    const initial = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-test",
      toolCallIds: ["call-test"],
      unstartedToolCallIds: ["call-test"],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
    });
    const writer = createStoreBoundRecoveryEvidenceWriter(store, () => false);
    await expect(
      writer(
        runtime,
        { unstartedToolCallIds: ["call-test"] },
        "before_tool_execution",
        initial.revision,
      ),
    ).rejects.toThrow("lost authority before commit");
    expect(store.read("agent-test", "conv-test")?.revision).toBe(
      initial.revision,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact recovery settlement retries beyond a live lock holder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-exact-result-lock-"));
  try {
    const store = createInterruptedTurnStore(directory);
    const listener = createRuntime();
    listener.connectionId = "conn-test";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-test",
      "conv-test",
    );
    const lineageId = "lineage-exact-lock";
    const running = store.write({
      agentId: "agent-test",
      conversationId: "conv-test",
      runId: "run-test",
      toolCallIds: ["call-test"],
      unstartedToolCallIds: [],
      results: [],
      requestOtid: "request-test",
      workingDirectory: "/project",
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-test"],
      },
    });
    const release = acquireDurableFileLock(
      join(directory, "agent-test_conv-test.json"),
      { waitMs: 10 },
    );
    const timer = setTimeout(release, 2_100);
    expect(
      await mergeSettledRecoveryResultRetriably(
        store,
        {
          agentId: runtime.agentId ?? "",
          conversationId: runtime.conversationId,
          lineageId,
          result: {
            type: "tool",
            tool_call_id: "call-test",
            tool_return: "settled exactly once",
            status: "success",
          },
        },
        5,
      ),
    ).toMatchObject({ independentSuccessor: false });
    clearTimeout(timer);
    expect(
      allRecordedResults(store.read("agent-test", "conv-test") ?? running),
    ).toContainEqual(
      expect.objectContaining({
        tool_call_id: "call-test",
        tool_return: "settled exactly once",
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
