import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordedToolResults,
} from "./interrupted-turn-record";

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

test("a failed state-file write reports its operation and does not persist a result", () => {
  const directory = mkdtempSync(join(tmpdir(), "listener-write-failure-"));
  const diskFull = Object.assign(
    new Error("private path should not be logged"),
    {
      code: "ENOSPC",
    },
  );
  const failures: Array<{ operation: string; error: unknown }> = [];
  const record: InterruptedTurnRecord = {
    agentId: "agent-test",
    conversationId: "conv-test",
    runId: "run-test",
    toolCallIds: ["call-test"],
    results: [],
    requestOtid: "request-test",
    workingDirectory: "/private/workspace",
  };
  try {
    const store = createInterruptedTurnStore(join(directory, "state"), {
      writeFile: () => {
        throw diskFull;
      },
      onWriteFailure: (operation, error) => {
        failures.push({ operation, error });
      },
    });

    expect(() => store.write(record)).toThrow(diskFull);
    expect(failures).toEqual([{ operation: "write", error: diskFull }]);
    expect(store.read(record.agentId, record.conversationId)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
