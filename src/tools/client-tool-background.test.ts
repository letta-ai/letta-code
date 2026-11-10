import { describe, expect, test } from "bun:test";
import { autoBackgroundClientTool } from "./client-tool-background";

type Result = { status: "success" | "error"; toolReturn: string };
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const scope = { agentId: "agent-test", conversationId: "conv-test" };

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
    operation.resolve({ status: "success", toolReturn: "stopped" });
    await Bun.sleep(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      ...scope,
      kind: "task_notification",
    });
    expect((notifications[0] as { text: string }).text).toContain("stopped");
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
