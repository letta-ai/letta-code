import { expect, test } from "bun:test";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import { startMemoryConflictRepair } from "./memory-conflict-repair";
import { runPostTurnMemorySync } from "./memory-git-sync";

const conflict: MemoryPostTurnSyncResult = {
  status: "conflict",
  memoryDir: "/tmp/test-memory-repair",
  summary: "merge in progress",
  localOnly: true,
};
test("post-turn conflict launches the memory task without parent reminders or a same-agent conversation", async () => {
  const jobs: SpawnBackgroundSubagentTaskArgs[] = [];
  const reminders: string[] = [];
  await runPostTurnMemorySync(
    {
      agentId: "agent-memory-repair-test",
      conversationId: "conv-origin",
      enqueueReminder: (text) => {
        reminders.push(text);
      },
    },
    {
      syncMemory: async () => conflict,
      syncAttachedRepositories: async () => ({ results: [] }),
      repairConflict: (params) =>
        startMemoryConflictRepair(params, (args) => {
          jobs.push(args);
          return {
            taskId: "task-repair",
            outputFile: "/tmp/repair.log",
            subagentId: "repair",
          };
        }),
    },
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    subagentType: "memory",
    memoryRepairOnly: true,
    silentCompletion: true,
    parentScope: {
      agentId: "agent-memory-repair-test",
      conversationId: "conv-origin",
    },
    memoryScope: {
      primaryRoot: conflict.memoryDir,
      writableRoots: [conflict.memoryDir],
    },
  });
  expect(jobs[0]?.existingConversationId).toBeUndefined();
  expect(jobs[0]?.existingAgentId).toBeUndefined();
  expect(reminders).toEqual([]);
});
test("dirty and failed primary memory sync do not inject repair work into the primary", async () => {
  for (const status of ["dirty", "push_failed"] as const) {
    const messages: string[] = [];
    await runPostTurnMemorySync(
      {
        agentId: "agent-memory-repair-test",
        enqueueReminder: (text) => {
          messages.push(text);
        },
        emitWarning: (text) => {
          messages.push(text);
        },
      },
      {
        syncMemory: async () => ({ ...conflict, status }),
        syncAttachedRepositories: async () => ({ results: [] }),
        repairConflict: () => {
          throw new Error("must not launch a conflict repair");
        },
      },
    );
    expect(messages).toEqual([]);
  }
});
