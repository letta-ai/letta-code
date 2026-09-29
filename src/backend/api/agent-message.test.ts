import { expect, test } from "bun:test";
import type { Backend } from "@/backend";
import {
  normalizeAgentMessageComputer,
  resolveAgentMessageDestination,
  resolveAgentMessagePullRequestConversationIds,
} from "./agent-message";

test.each(["default", "conv-child"])(
  "continuation attribution reads only the target's exact %s tags",
  async (conversationId) => {
    const reads: string[] = [];
    const tags = [
      "parent-conversation:agent-parent/conv-old",
      "parent-conversation:agent-parent/conv-current",
    ];
    const backend = {
      retrieveAgent: async (id: string, options: { include?: string[] }) => {
        reads.push(id);
        return { tags: options.include?.includes("agent.tags") ? tags : [] };
      },
      retrieveConversation: async (id: string) => {
        reads.push(id);
        return { tags };
      },
    } as unknown as Backend;
    expect(
      await resolveAgentMessagePullRequestConversationIds(
        {
          sender: { agentId: "agent-parent", conversationId: "conv-current" },
          target: { agentId: "agent-child", conversationId },
          inheritedConversationIds: ["conv-root", "conv-current"],
        },
        backend,
      ),
    ).toEqual(["conv-root", "conv-current"]);
    expect(reads).toEqual([
      conversationId === "default" ? "agent-child" : "conv-child",
    ]);
  },
);

test.each([
  {
    name: "another conversation of the launching agent",
    sender: { agentId: "agent-parent", conversationId: "conv-unrelated" },
  },
  {
    name: "child replying to its parent",
    sender: { agentId: "agent-child", conversationId: "conv-child" },
  },
  {
    name: "unrelated agent",
    sender: { agentId: "agent-peer", conversationId: "conv-current" },
  },
  { name: "unknown sender", sender: {} },
])("does not turn $name into a new parent", async ({ sender }) => {
  const backend = {
    retrieveAgent: async () => ({
      tags: ["parent-conversation:agent-parent/conv-current"],
    }),
    retrieveConversation: async () => ({
      tags: ["parent-conversation:agent-parent/conv-current"],
    }),
  } as unknown as Backend;
  for (const conversationId of ["default", "conv-target"]) {
    expect(
      await resolveAgentMessagePullRequestConversationIds(
        {
          sender,
          target: { agentId: "agent-target", conversationId },
          inheritedConversationIds: ["conv-root"],
        },
        backend,
      ),
    ).toEqual([]);
  }
});

test("a named target does not inherit an agent-wide parent relationship", async () => {
  const backend = {
    retrieveAgent: async () => {
      throw new Error("must not read agent tags for named scopes");
    },
    retrieveConversation: async () => ({ tags: [] }),
  } as unknown as Backend;
  expect(
    await resolveAgentMessagePullRequestConversationIds(
      {
        sender: { agentId: "agent-parent", conversationId: "conv-parent" },
        target: { agentId: "agent-child", conversationId: "conv-unrelated" },
      },
      backend,
    ),
  ).toEqual([]);
});

test("failed attribution lookup is best effort for both tag surfaces", async () => {
  const backend = {
    retrieveAgent: async () => {
      throw new Error("503");
    },
    retrieveConversation: async () => {
      throw new Error("404");
    },
  } as unknown as Backend;
  for (const conversationId of ["default", "conv-child"]) {
    expect(
      await resolveAgentMessagePullRequestConversationIds(
        {
          sender: { agentId: "agent-parent", conversationId: "conv-parent" },
          target: { agentId: "agent-child", conversationId },
        },
        backend,
      ),
    ).toEqual([]);
  }
});

test("default parents carry named ancestors without sending invalid or oversized metadata", async () => {
  const backend = {
    retrieveAgent: async () => ({
      tags: ["parent-conversation:agent-parent/default"],
    }),
  } as unknown as Backend;
  const ids = Array.from({ length: 25 }, (_, i) => `conv-parent-${i}`);
  expect(
    await resolveAgentMessagePullRequestConversationIds(
      {
        sender: { agentId: "agent-parent", conversationId: "default" },
        target: { agentId: "agent-child", conversationId: "default" },
        inheritedConversationIds: ["", ...ids],
      },
      backend,
    ),
  ).toEqual(ids.slice(-20));
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
