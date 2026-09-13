import { describe, expect, test } from "bun:test";
import type { SubagentConfig } from "@/agent/subagents";
import type { Backend } from "@/backend";
import { forkParentConversation } from "./task";

const forkConfig: SubagentConfig = {
  name: "fork",
  description: "Fork the parent conversation",
  systemPrompt: "",
  allowedTools: "all",
  recommendedModel: "inherit",
  recommendedModelSource: "builtin",
  skills: [],
  fork: true,
  launchProfile: "default",
};

function backendFixture(events: string[]) {
  return {
    forkConversation: async (conversationId: string) => {
      events.push(`fork:${conversationId}`);
      return { id: "conv-fork" };
    },
    deleteConversation: async (conversationId: string) => {
      events.push(`delete:${conversationId}`);
    },
  } as unknown as Backend;
}

describe("forkParentConversation", () => {
  test("applies the model only to the forked conversation before launch", async () => {
    const events: string[] = [];
    const result = await forkParentConversation(
      {
        backend: backendFixture(events),
        parentAgentId: "agent-parent",
        parentConversationId: "conv-parent",
        config: forkConfig,
        model: "gpt-5.6-sol",
      },
      {
        resolveModelOverride: async () => {
          events.push("resolve");
          return {
            modelHandle: "feather-openai/gpt-5.6-sol",
            updateArgs: { reasoning_effort: "high" },
          };
        },
        updateConversationModel: async (
          conversationId,
          modelHandle,
          updateArgs,
        ) => {
          events.push(
            `model:${conversationId}:${modelHandle}:${updateArgs?.reasoning_effort}`,
          );
        },
        inheritToolset: async (_agentId, parentId, forkId) => {
          events.push(`toolset:${parentId}:${forkId}`);
        },
      },
    );

    expect(result.id).toBe("conv-fork");
    expect(events).toEqual([
      "resolve",
      "fork:conv-parent",
      "model:conv-fork:feather-openai/gpt-5.6-sol:high",
      "toolset:conv-parent:conv-fork",
    ]);
    expect(events.some((event) => event.includes("model:conv-parent"))).toBe(
      false,
    );
  });

  test("preserves model inheritance when no override is configured", async () => {
    const events: string[] = [];
    await forkParentConversation(
      {
        backend: backendFixture(events),
        parentAgentId: "agent-parent",
        parentConversationId: "conv-parent",
        config: forkConfig,
      },
      {
        resolveModelOverride: async () => null,
        updateConversationModel: async () => {
          events.push("unexpected-model-update");
        },
        inheritToolset: async () => undefined,
      },
    );

    expect(events).toEqual(["fork:conv-parent"]);
  });

  test("validates the model before creating a hidden conversation", async () => {
    const events: string[] = [];
    await expect(
      forkParentConversation(
        {
          backend: backendFixture(events),
          parentAgentId: "agent-parent",
          parentConversationId: "conv-parent",
          config: forkConfig,
          model: "missing-model",
        },
        {
          resolveModelOverride: async () => {
            throw new Error("Unknown fork model: missing-model");
          },
        },
      ),
    ).rejects.toThrow("Unknown fork model: missing-model");

    expect(events).toEqual([]);
  });

  test("deletes the hidden fork when its model update fails", async () => {
    const events: string[] = [];
    await expect(
      forkParentConversation(
        {
          backend: backendFixture(events),
          parentAgentId: "agent-parent",
          parentConversationId: "conv-parent",
          config: forkConfig,
        },
        {
          resolveModelOverride: async () => ({
            modelHandle: "openai/gpt-5.6-sol",
          }),
          updateConversationModel: async () => {
            events.push("model-failed");
            throw new Error("model update failed");
          },
        },
      ),
    ).rejects.toThrow("model update failed");

    expect(events).toEqual([
      "fork:conv-parent",
      "model-failed",
      "delete:conv-fork",
    ]);
  });
});
