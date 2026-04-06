import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { SubagentState } from "../../cli/helpers/subagentState";
import {
  clearAllSubagents,
  registerSubagent,
  updateSubagent,
} from "../../cli/helpers/subagentState";
import {
  __resetBackgroundRetentionConfigForTests,
  __setBackgroundRetentionConfigForTests,
  backgroundTasks,
} from "../../tools/impl/process_manager";
import {
  spawnBackgroundSubagentTask,
  waitForBackgroundSubagentLink,
} from "../../tools/impl/Task";

describe("spawnBackgroundSubagentTask", () => {
  let subagentCounter = 0;
  const queueMessages: Array<{
    kind: "user" | "task_notification";
    text: string;
  }> = [];

  const generateSubagentIdImpl = () => {
    subagentCounter += 1;
    return `subagent-test-${subagentCounter}`;
  };

  const registerSubagentImpl = mock(
    (
      _id: string,
      _type: string,
      _description: string,
      _toolCallId?: string,
      _isBackground?: boolean,
    ) => {},
  );
  const completeSubagentImpl = mock(
    (_id: string, _result: { success: boolean; error?: string }) => {},
  );
  const buildSnapshot = (id: string): SubagentState => ({
    id,
    type: "Reflection",
    description: "Reflect on memory",
    status: "running",
    agentURL: null,
    toolCalls: [
      { id: "tc-1", name: "Read", args: "{}" },
      { id: "tc-2", name: "Edit", args: "{}" },
    ],
    maxToolCallsSeen: 2,
    totalTokens: 0,
    durationMs: 0,
    startTime: Date.now(),
  });
  const getSubagentSnapshotImpl = () => ({
    agents: [buildSnapshot("subagent-test-1")],
    expanded: false,
  });
  const addToMessageQueueImpl = (msg: {
    kind: "user" | "task_notification";
    text: string;
  }) => {
    queueMessages.push(msg);
  };
  const formatTaskNotificationImpl = mock(
    (_args: unknown) => "<task-notification/>",
  );
  const runSubagentStopHooksImpl = mock(async () => ({
    blocked: false,
    errored: false,
    feedback: [],
    results: [],
  }));

  beforeEach(() => {
    subagentCounter = 0;
    queueMessages.length = 0;
    registerSubagentImpl.mockClear();
    completeSubagentImpl.mockClear();
    formatTaskNotificationImpl.mockClear();
    runSubagentStopHooksImpl.mockClear();
    __resetBackgroundRetentionConfigForTests();
    backgroundTasks.clear();
    clearAllSubagents();
  });

  afterEach(() => {
    for (const task of backgroundTasks.values()) {
      if (existsSync(task.outputFile)) {
        unlinkSync(task.outputFile);
      }
    }
    __resetBackgroundRetentionConfigForTests();
    backgroundTasks.clear();
    clearAllSubagents();
  });

  test("runs background subagent and preserves queue + hook behavior on success", async () => {
    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-123",
      conversationId: "default",
      report: "reflection done",
      success: true,
      totalTokens: 55,
    }));

    const launched = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    expect(launched.taskId).toMatch(/^task_\d+$/);
    expect(launched.subagentId).toBe("subagent-test-1");
    expect(backgroundTasks.get(launched.taskId)?.status).toBe("running");
    expect(registerSubagentImpl).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = backgroundTasks.get(launched.taskId);
    expect(task?.status).toBe("completed");
    expect(task?.output[0]).toContain("reflection done");
    expect(completeSubagentImpl).toHaveBeenCalledTimes(1);
    expect(queueMessages.length).toBe(1);
    expect(runSubagentStopHooksImpl).toHaveBeenCalledWith(
      "reflection",
      "subagent-test-1",
      true,
      undefined,
      "agent-123",
      "default",
    );

    const outputContent = readFileSync(launched.outputFile, "utf-8");
    expect(outputContent).toContain("[Task started: Reflect on memory]");
    expect(outputContent).toContain("[Task completed]");
  });

  test("silentCompletion skips message queue notification", async () => {
    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-silent",
      conversationId: "default",
      report: "init done",
      success: true,
      totalTokens: 30,
    }));

    const launched = spawnBackgroundSubagentTask({
      subagentType: "init",
      prompt: "Init memory",
      description: "Initializing memory",
      silentCompletion: true,
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = backgroundTasks.get(launched.taskId);
    expect(task?.status).toBe("completed");
    expect(task?.output[0]).toContain("init done");
    expect(completeSubagentImpl).toHaveBeenCalledTimes(1);
    // No notification queued
    expect(queueMessages.length).toBe(0);
    expect(formatTaskNotificationImpl).not.toHaveBeenCalled();
    // Hooks still run
    expect(runSubagentStopHooksImpl).toHaveBeenCalledTimes(1);
  });

  test("emitCompletionNotification can re-enable notifications for silent completions", async () => {
    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-silent-notify",
      conversationId: "default",
      report: "reflection done",
      success: true,
      totalTokens: 31,
    }));

    spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      silentCompletion: true,
      emitCompletionNotification: true,
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queueMessages.length).toBe(1);
    expect(formatTaskNotificationImpl).toHaveBeenCalledTimes(1);
  });

  test("completionSummary overrides the notification summary", async () => {
    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-summary",
      conversationId: "default",
      report: "reflection done",
      success: true,
      totalTokens: 31,
    }));

    spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      silentCompletion: true,
      emitCompletionNotification: true,
      completionSummary:
        "Reflected on the memory palace, the halls remember more now",
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(formatTaskNotificationImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Reflected on the memory palace, the halls remember more now",
      }),
    );
  });

  test("awaits async onComplete before queue notification and hooks", async () => {
    const callOrder: string[] = [];
    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-ordered",
      conversationId: "default",
      report: "reflection done",
      success: true,
      totalTokens: 22,
    }));
    const addToMessageQueueOrdered = mock(
      (_msg: { kind: "user" | "task_notification"; text: string }) => {
        callOrder.push("queue");
      },
    );
    const runSubagentStopHooksOrdered = mock(async () => {
      callOrder.push("hooks");
      return {
        blocked: false,
        errored: false,
        feedback: [],
        results: [],
      };
    });
    const onComplete = mock(async () => {
      callOrder.push("onComplete:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      callOrder.push("onComplete:end");
    });

    spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      onComplete,
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl: addToMessageQueueOrdered,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl: runSubagentStopHooksOrdered,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(callOrder).toEqual([
      "onComplete:start",
      "onComplete:end",
      "queue",
      "hooks",
    ]);
  });

  test("continues queue notification and hooks when onComplete throws", async () => {
    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-oncomplete-error",
      conversationId: "default",
      report: "reflection done",
      success: true,
      totalTokens: 19,
    }));
    const onComplete = mock(async () => {
      throw new Error("callback exploded");
    });

    const launched = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      onComplete,
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queueMessages).toHaveLength(1);
    expect(runSubagentStopHooksImpl).toHaveBeenCalledTimes(1);
    const outputContent = readFileSync(launched.outputFile, "utf-8");
    expect(outputContent).toContain("[onComplete error] callback exploded");
  });

  test("evicts completed background tasks after the retention window", async () => {
    __setBackgroundRetentionConfigForTests({ completedEntryTtlMs: 20 });

    const spawnSubagentImpl = mock(async () => ({
      agentId: "agent-evict",
      conversationId: "default",
      report: "done",
      success: true,
      totalTokens: 7,
    }));

    const launched = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backgroundTasks.has(launched.taskId)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(backgroundTasks.has(launched.taskId)).toBe(false);
    expect(existsSync(launched.outputFile)).toBe(true);
    unlinkSync(launched.outputFile);
  });

  test("refuses to start a new background task after the running cap", () => {
    __setBackgroundRetentionConfigForTests({ maxRunningTasks: 1 });

    const spawnSubagentImpl = mock(() => new Promise<never>(() => {}));

    spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    expect(() =>
      spawnBackgroundSubagentTask({
        subagentType: "reflection",
        prompt: "Reflect again",
        description: "Reflect on memory again",
        deps: {
          spawnSubagentImpl,
          addToMessageQueueImpl,
          formatTaskNotificationImpl,
          runSubagentStopHooksImpl,
          generateSubagentIdImpl,
          registerSubagentImpl,
          completeSubagentImpl,
          getSubagentSnapshotImpl,
        },
      }),
    ).toThrow("Too many background tasks already running");
  });

  test("marks background task failed and emits notification on error", async () => {
    const spawnSubagentImpl = mock(async () => {
      throw new Error("subagent exploded");
    });

    const launched = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "Reflect",
      description: "Reflect on memory",
      deps: {
        spawnSubagentImpl,
        addToMessageQueueImpl,
        formatTaskNotificationImpl,
        runSubagentStopHooksImpl,
        generateSubagentIdImpl,
        registerSubagentImpl,
        completeSubagentImpl,
        getSubagentSnapshotImpl,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = backgroundTasks.get(launched.taskId);
    expect(task?.status).toBe("failed");
    expect(task?.error).toBe("subagent exploded");
    expect(queueMessages.length).toBe(1);
    expect(runSubagentStopHooksImpl).toHaveBeenCalledWith(
      "reflection",
      "subagent-test-1",
      false,
      "subagent exploded",
      undefined,
      undefined,
    );

    const outputContent = readFileSync(launched.outputFile, "utf-8");
    expect(outputContent).toContain("[error] subagent exploded");
  });
});

describe("waitForBackgroundSubagentLink", () => {
  afterEach(() => {
    clearAllSubagents();
  });

  test("returns after agent URL becomes available", async () => {
    registerSubagent("subagent-link-1", "reflection", "Reflect", "tc-1", true);

    setTimeout(() => {
      updateSubagent("subagent-link-1", {
        agentURL: "https://app.letta.com/chat/agent-123",
      });
    }, 20);

    const start = Date.now();
    await waitForBackgroundSubagentLink("subagent-link-1", 300);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(10);
    expect(elapsed).toBeLessThan(250);
  });

  test("times out when URL is unavailable", async () => {
    registerSubagent("subagent-link-2", "reflection", "Reflect", "tc-2", true);

    const start = Date.now();
    await waitForBackgroundSubagentLink("subagent-link-2", 70);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
