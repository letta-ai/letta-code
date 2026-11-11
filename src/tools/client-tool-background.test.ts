import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";
import {
  autoBackgroundClientTool,
  FOREGROUND_TOOL_TIMEOUT_MS,
  WORKTREE_TOOL_TIMEOUT_MS,
} from "./client-tool-background";

const existingEntries = new Set<string>();
beforeEach(() => {
  existingEntries.clear();
  for (const id of backgroundProcesses.keys()) existingEntries.add(id);
});
afterEach(() => {
  for (const [id, entry] of backgroundProcesses) {
    if (existingEntries.has(id)) continue;
    clearBackgroundProcessCleanup(id);
    if (entry.outputFile) rmSync(entry.outputFile, { force: true });
    backgroundProcesses.delete(id);
  }
});
type Result = { status: "success" | "error"; toolReturn: string };
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const scope = { agentId: "agent-test", conversationId: "conv-test" };

function backgroundEntry(receipt: { toolReturn: unknown }) {
  const id = String(receipt.toolReturn).match(/task ID: (\S+)/)?.[1];
  const entry = id ? backgroundProcesses.get(id) : undefined;
  if (!id || !entry) throw new Error("Missing returned background task");
  return [id, entry] as const;
}

describe("client tool foreground budget", () => {
  test("a stuck TaskStop yields once and delivers its late result", async () => {
    const operation = deferred();
    const notifications: unknown[] = [];
    const receipt = await autoBackgroundClientTool(
      "TaskStop",
      operation.promise,
      {
        yieldMs: 5,
        runtimeScope: scope,
        enqueue: (message) => notifications.push(message),
      },
    );
    expect(receipt.status).toBe("success");
    expect(notifications).toHaveLength(0);
    const [, entry] = backgroundEntry(receipt);
    expect(entry?.status).toBe("running");
    expect(readFileSync(entry?.outputFile as string, "utf8")).toBe("");
    operation.resolve({ status: "success", toolReturn: "stopped" });
    await Bun.sleep(0);
    expect(notifications).toHaveLength(1);
    expect(entry?.status).toBe("completed");
    expect(readFileSync(entry?.outputFile as string, "utf8")).toContain(
      "stopped",
    );
    expect(notifications[0]).toMatchObject({
      ...scope,
      kind: "task_notification",
    });
    expect((notifications[0] as { text: string }).text).toContain("stopped");
  });

  test("TaskStop aborts a local call, retains output, and suppresses its notification", async () => {
    const notifications: unknown[] = [];
    let signal!: AbortSignal;
    let progress!: (chunk: string, stream: "stdout" | "stderr") => void;
    const receipt = await autoBackgroundClientTool(
      "Grep",
      (callSignal, onOutput) => {
        signal = callSignal;
        progress = onOutput;
        return new Promise<Result>((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ status: "error", toolReturn: "aborted" }),
          );
        });
      },
      {
        yieldMs: 1,
        runtimeScope: scope,
        enqueue: (message) => notifications.push(message),
      },
    );
    const [id, entry] = backgroundEntry(receipt);
    progress("searching\n", "stdout");
    expect(readFileSync(entry.outputFile as string, "utf8")).toContain(
      "searching",
    );
    expect(await task_stop({ task_id: id })).toEqual({
      killed: true,
      output: "Stopped",
    });
    expect(signal.aborted).toBe(true);
    await Bun.sleep(0);
    expect(entry.status).toBe("failed");
    expect(backgroundProcesses.get(id)).toBe(entry);
    expect(readFileSync(entry.outputFile as string, "utf8")).toContain(
      "aborted",
    );
    expect(notifications).toHaveLength(0);
  });

  test.each([false, true])(
    "abort preserves a built-in's result (notification delivery %s)",
    async (connected) => {
      const operation = deferred();
      const controller = new AbortController();
      const notifications: unknown[] = [];
      let finished = false;
      const pending = autoBackgroundClientTool("Grep", operation.promise, {
        yieldMs: 5,
        signal: controller.signal,
        ...(connected
          ? {
              runtimeScope: scope,
              enqueue: (message: unknown) => notifications.push(message),
            }
          : {}),
      }).then((result) => {
        finished = true;
        return result;
      });
      controller.abort();
      await Bun.sleep(10);
      expect(finished).toBe(false);
      operation.resolve({
        status: "error",
        toolReturn: "cancelled by implementation",
      });
      expect(await pending).toEqual({
        status: "error",
        toolReturn: "cancelled by implementation",
      });
      expect(notifications).toHaveLength(0);
    },
  );

  test.each([
    "Edit",
    "Memory",
    "Write",
    "ApplyPatch",
    "write_artifact_file",
    "SetWorkingDirectory",
    "EnterWorktree",
    "ExitWorktree",
    "UpdatePlan",
    "TaskCreate",
    "TaskUpdate",
    "AskUserQuestionAsync",
    "Bash",
    "exec_command",
    "CodeMode",
  ])("%s keeps its own foreground lifecycle", async (name) => {
    const operation = deferred();
    const notifications: unknown[] = [];
    let finished = false;
    const result = autoBackgroundClientTool(name, operation.promise, {
      yieldMs: 1,
      runtimeScope: scope,
      enqueue: (message) => notifications.push(message),
    }).then((value) => {
      finished = true;
      return value;
    });
    await Bun.sleep(10);
    expect(finished).toBe(false);
    operation.resolve({ status: "success", toolReturn: "done" });
    expect(await result).toEqual({ status: "success", toolReturn: "done" });
    expect(notifications).toHaveLength(0);
  });
});

describe("foreground tool timeout", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  async function settledAfter(name: string, advanceMs: number) {
    jest.useFakeTimers();
    let signal!: AbortSignal;
    let settled: unknown;
    void autoBackgroundClientTool(
      name,
      (callSignal) => {
        signal = callSignal;
        return new Promise<Result>(() => {});
      },
      { yieldMs: 1, runtimeScope: scope, enqueue: () => {} },
    ).then((result) => {
      settled = result;
    });
    jest.advanceTimersByTime(advanceMs);
    jest.useRealTimers();
    await Bun.sleep(0);
    return { settled, signal };
  }

  test.each([
    "Edit",
    "Memory",
    "Write",
    "ApplyPatch",
    "write_artifact_file",
    "SetWorkingDirectory",
    "UpdatePlan",
    "TaskCreate",
    "TaskUpdate",
  ])("a hung %s fails with a timeout error and aborts", async (name) => {
    const early = await settledAfter(name, FOREGROUND_TOOL_TIMEOUT_MS - 1);
    expect(early.settled).toBeUndefined();
    const { settled, signal } = await settledAfter(
      name,
      FOREGROUND_TOOL_TIMEOUT_MS,
    );
    expect(settled).toEqual({
      status: "error",
      toolReturn: `${name} did not finish within 10s and was abandoned. Its change may still have been applied; re-read the affected file or state before retrying.`,
    });
    expect(signal.aborted).toBe(true);
    expect(backgroundProcesses.size).toBe(existingEntries.size);
  });

  test.each(["EnterWorktree", "ExitWorktree"])(
    "%s gets the longer worktree cap",
    async (name) => {
      expect(WORKTREE_TOOL_TIMEOUT_MS).toBe(60_000);
      const early = await settledAfter(name, WORKTREE_TOOL_TIMEOUT_MS - 1);
      expect(early.settled).toBeUndefined();
      expect(early.signal.aborted).toBe(false);
      const { settled } = await settledAfter(name, WORKTREE_TOOL_TIMEOUT_MS);
      expect(settled).toMatchObject({
        status: "error",
        toolReturn: expect.stringContaining("did not finish within 60s"),
      });
    },
  );

  test("AskUserQuestionAsync is not capped", async () => {
    const { settled, signal } = await settledAfter(
      "AskUserQuestionAsync",
      60 * 60_000,
    );
    expect(settled).toBeUndefined();
    expect(signal.aborted).toBe(false);
  });

  test("a foreground tool that finishes in time keeps its result", async () => {
    jest.useFakeTimers();
    const result = await autoBackgroundClientTool(
      "Edit",
      Promise.resolve<Result>({ status: "success", toolReturn: "edited" }),
      { yieldMs: 1 },
    );
    expect(result).toEqual({ status: "success", toolReturn: "edited" });
    expect(jest.getTimerCount()).toBe(0);
  });
});
