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

  test("deduplicates maintenance while the agent already has one running", async () => {
    let onComplete:
      | Parameters<typeof spawnBackgroundSubagentTask>[0]["onComplete"]
      | undefined;
    const spawnTask: typeof spawnBackgroundSubagentTask = (args) => {
      onComplete = args.onComplete;
      return {
        taskId: "task-memory",
        outputFile: "/tmp/task-memory.log",
        subagentId: "subagent-memory",
      };
    };
    const params = {
      agentId: "agent-memory-dedupe",
      sourceConversationId: "conv-active",
      context: "memory needs attention",
    };
    const dependencies = {
      spawnTask,
      waitForConversationId: async () => null,
      updateConversation: async () => undefined,
    };

    expect(launchMemoryConversation(params, dependencies)).toEqual({
      launched: true,
    });
    expect(launchMemoryConversation(params, dependencies)).toEqual({
      launched: false,
      reason: "already_active",
    });

    await onComplete?.({ success: false });
    expect(launchMemoryConversation(params, dependencies)).toEqual({
      launched: true,
    });
    await onComplete?.({ success: false });
  });

  test("tells the maintenance turn not to return context to the source", () => {
    expect(buildMemoryConversationPrompt("memory issue")).toContain(
      "Do not send this context back into the source conversation.",
    );
  });
});
