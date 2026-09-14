import { expect, test } from "bun:test";
import type { Backend } from "@/backend";
import {
  normalizeAgentMessageComputer,
  resolveAgentMessageDestination,
} from "./agent-message";

test("addresses ephemeral children through their stored permission inheritance", async () => {
  const backend = {
    retrieveConversation: async () => ({
      id: "conv-child",
      agent_id: null,
      parent_agent_id: "agent-parent",
    }),
  } as unknown as Backend;
  expect(
    await resolveAgentMessageDestination(
      { conversationId: "conv-child" },
      backend,
    ),
  ).toEqual({ agentId: "agent-parent", conversationId: "conv-child" });
  await expect(
    resolveAgentMessageDestination(
      { agentId: "agent-other", conversationId: "conv-child" },
      backend,
    ),
  ).rejects.toThrow("does not belong");
});

test.each([
  ["agent-current", "conv-current", "agent-current", "conv-current", true],
  ["agent-current", "default", "agent-current", "default", true],
  ["agent-other", "default", "agent-current", "default", false],
  ["agent-current", "conv-fork", "agent-current", "conv-current", false],
  ["agent-current", "default", "agent-current", "conv-current", false],
  ["agent-current", undefined, "agent-current", "conv-current", false],
])(
  "resolved destination %s/%s compared with runtime %s/%s",
  async (
    agentId,
    conversationId,
    currentAgentId,
    currentConversationId,
    reject,
  ) => {
    let creations = 0;
    const backend = {
      retrieveConversation: async (id: string) => ({ id, agent_id: agentId }),
      createConversation: async () => {
        creations++;
        return { id: "conv-new" };
      },
    } as unknown as Backend;
    const result = resolveAgentMessageDestination(
      {
        agentId,
        conversationId,
        senderAgentId: "agent-overridden",
        currentConversation: {
          agentId: currentAgentId,
          conversationId: currentConversationId,
        },
      },
      backend,
    );
    if (reject) {
      await expect(result).rejects.toThrow(
        "Cannot message the current conversation",
      );
    } else {
      expect(await result).toEqual({
        agentId,
        conversationId: conversationId ?? "conv-new",
      });
    }
    expect(creations).toBe(conversationId ? 0 : 1);
  },
);

test.each([undefined, null, "", " \t\n"])(
  "an unset optional computer uses the existing destination: %j",
  (value) => {
    expect(normalizeAgentMessageComputer(value)).toBeUndefined();
  },
);

test.each([
  ["cloud", "cloud"],
  [" Cloud-Sandbox ", "cloud"],
  [" My laptop ", "My laptop"],
  ["device-123", "device-123"],
])("normalizes %s to %s", (input, expected) => {
  expect(normalizeAgentMessageComputer(input)).toBe(expected);
});

test.each([{ value: false }, { value: 0 }, { value: [] }, { value: {} }])(
  "rejects an invalid computer value %j",
  ({ value }) => {
    expect(() => normalizeAgentMessageComputer(value)).toThrow(
      "computer must be a computer name, or omitted",
    );
  },
);
