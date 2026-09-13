import { describe, expect, test } from "bun:test";
import { syncReflectionCompletionToCloud } from "./reflection-completion";

describe("reflection completion Cloud sync", () => {
  test("creates config before writing conversation cursors", async () => {
    const calls: string[] = [];
    await syncReflectionCompletionToCloud(
      {
        agentId: "agent-1",
        checkpoints: [
          {
            conversationId: "conversation-1",
            reflectedThroughMessageId: "message-1",
          },
          {
            conversationId: "conversation-2",
            reflectedThroughMessageId: "message-2",
          },
        ],
      },
      {
        isCloud: async () => true,
        getSettings: () => ({
          trigger: "step-count",
          stepCount: 12,
          merge: "auto",
        }),
        updateConfig: async (agentId, input) => {
          calls.push(
            `config:${agentId}:${input.enabled}:${input.min_turn_count}`,
          );
        },
        updateProgress: async (agentId, conversationId, input) => {
          calls.push(
            `progress:${agentId}:${conversationId}:${input.reflected_through_message_id}`,
          );
        },
      },
    );

    expect(calls).toEqual([
      "config:agent-1:true:12",
      "progress:agent-1:conversation-1:message-1",
      "progress:agent-1:conversation-2:message-2",
    ]);
  });

  test("writes disabled config for a manually completed reflection", async () => {
    const configs: Array<{ enabled: boolean; min_turn_count: number }> = [];
    await syncReflectionCompletionToCloud(
      { agentId: "agent-1", checkpoints: [] },
      {
        isCloud: async () => true,
        getSettings: () => ({ trigger: "off", stepCount: 25 }),
        updateConfig: async (_agentId, input) => {
          configs.push(input);
        },
      },
    );

    expect(configs).toEqual([{ enabled: false, min_turn_count: 25 }]);
  });

  test("skips local agents", async () => {
    let writes = 0;
    await syncReflectionCompletionToCloud(
      {
        agentId: "agent-local",
        checkpoints: [
          {
            conversationId: "default",
            reflectedThroughMessageId: "message-1",
          },
        ],
      },
      {
        isCloud: async () => false,
        updateConfig: async () => {
          writes += 1;
        },
        updateProgress: async () => {
          writes += 1;
        },
      },
    );

    expect(writes).toBe(0);
  });

  test("keeps reflection completion successful when Cloud config sync fails", async () => {
    let cursorWrites = 0;
    const warnings: string[] = [];
    await syncReflectionCompletionToCloud(
      {
        agentId: "agent-1",
        checkpoints: [
          {
            conversationId: "default",
            reflectedThroughMessageId: "message-1",
          },
        ],
      },
      {
        isCloud: async () => true,
        getSettings: () => ({ trigger: "step-count", stepCount: 25 }),
        updateConfig: async () => {
          throw new Error("offline");
        },
        updateProgress: async () => {
          cursorWrites += 1;
        },
        logWarning: (message) => warnings.push(message),
      },
    );

    expect(cursorWrites).toBe(0);
    expect(warnings).toEqual([
      "Failed to sync Cloud reflection config: offline",
    ]);
  });
});
