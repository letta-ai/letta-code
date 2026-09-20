import { describe, expect, test } from "bun:test";
import type { spawnBackgroundSubagentTask } from "@/tools/impl/task";
import {
  buildMemoryConversationPrompt,
  launchMemoryConversation,
} from "./memory-conversation";

describe("memory maintenance conversations", () => {
  test("moves memory context into a silent fresh conversation", async () => {
    let captured: Parameters<typeof spawnBackgroundSubagentTask>[0] | undefined;
    const updates: Array<{ conversationId: string; summary: string }> = [];
    const spawnTask: typeof spawnBackgroundSubagentTask = (args) => {
      captured = args;
      return {
        taskId: "task-memory",
        outputFile: "/tmp/task-memory.log",
        subagentId: "subagent-memory",
      };
    };

    const result = launchMemoryConversation(
      {
        agentId: "agent-memory-route",
        sourceConversationId: "conv-active",
        actingUserId: "user-source",
        context:
          "<system-reminder>MEMORY GIT CONFLICT: rebase in progress</system-reminder>",
      },
      {
        spawnTask,
        waitForConversationId: async () => "conv-memory",
        updateConversation: async (conversationId, body) => {
          updates.push({ conversationId, summary: body.summary });
        },
      },
    );

    expect(result).toEqual({ launched: true });
    expect(captured).toMatchObject({
      subagentType: "general-purpose",
      displayType: "memory maintenance",
      existingAgentId: "agent-memory-route",
      parentScope: {
        agentId: "agent-memory-route",
        conversationId: "conv-active",
      },
      actingUserId: "user-source",
      silentCompletion: true,
      emitCompletionNotification: false,
    });
    expect(captured?.prompt).toContain("MEMORY GIT CONFLICT");
    expect(captured?.prompt).not.toContain("<system-reminder>");

    await Promise.resolve();
    expect(updates).toEqual([
      { conversationId: "conv-memory", summary: "Memory maintenance" },
    ]);

    await captured?.onComplete?.({
      success: true,
      conversationId: "conv-memory",
    });
    expect(updates.at(-1)).toEqual({
      conversationId: "conv-memory",
      summary: "Memory maintenance — resolved",
    });
  });

  test("queues maintenance while the agent already has one running", async () => {
    const launches: Parameters<typeof spawnBackgroundSubagentTask>[0][] = [];
    const spawnTask: typeof spawnBackgroundSubagentTask = (args) => {
      launches.push(args);
      return {
        taskId: `task-memory-${launches.length}`,
        outputFile: `/tmp/task-memory-${launches.length}.log`,
        subagentId: `subagent-memory-${launches.length}`,
      };
    };
    const first = {
      agentId: "agent-memory-dedupe",
      sourceConversationId: "conv-active",
      context: "first memory issue",
    };
    const second = { ...first, context: "second memory issue" };
    const dependencies = {
      spawnTask,
      waitForConversationId: async () => null,
      updateConversation: async () => undefined,
    };

    expect(launchMemoryConversation(first, dependencies)).toEqual({
      launched: true,
    });
    expect(launchMemoryConversation(second, dependencies)).toEqual({
      launched: false,
      reason: "queued",
    });
    expect(launches).toHaveLength(1);

    await launches[0]?.onComplete?.({ success: false });
    expect(launches).toHaveLength(2);
    expect(launches[1]?.prompt).toContain("second memory issue");
    await launches[1]?.onComplete?.({ success: false });
  });

  test("retries a maintenance launch without dropping its context", async () => {
    let attempts = 0;
    let retry: (() => void) | undefined;
    let retryDelayMs: number | undefined;
    let completed:
      | Parameters<typeof spawnBackgroundSubagentTask>[0]["onComplete"]
      | undefined;
    const spawnTask: typeof spawnBackgroundSubagentTask = (args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("task pool full");
      completed = args.onComplete;
      return {
        taskId: "task-memory-retry",
        outputFile: "/tmp/task-memory-retry.log",
        subagentId: "subagent-memory-retry",
      };
    };

    expect(
      launchMemoryConversation(
        {
          agentId: "agent-memory-retry",
          sourceConversationId: "conv-active",
          context: "retry this memory issue",
        },
        {
          spawnTask,
          waitForConversationId: async () => null,
          updateConversation: async () => undefined,
          scheduleRetry: (callback, delayMs) => {
            retry = callback;
            retryDelayMs = delayMs;
          },
        },
      ),
    ).toEqual({ launched: false, reason: "launch_failed" });
    expect(attempts).toBe(1);
    expect(retryDelayMs).toBe(1_000);

    retry?.();
    expect(attempts).toBe(2);
    await completed?.({ success: false });
  });

  test("tells the maintenance turn not to return context to the source", () => {
    expect(buildMemoryConversationPrompt("memory issue")).toContain(
      "Do not send this context back into the source conversation.",
    );
  });
});
