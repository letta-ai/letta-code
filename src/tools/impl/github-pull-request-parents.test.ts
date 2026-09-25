import { expect, test } from "bun:test";
import {
  getPullRequestParentConversationIds,
  type ParentConversationBackend,
} from "./github-pull-request-parents";

test("follows exact named scopes, default intermediaries and cycles without agent-wide leakage", async () => {
  const conversations: Record<string, string[]> = {
    "conv-child": [
      "parent-conversation:agent-one/conv-one",
      "parent-conversation:agent-one/conv-two",
    ],
    "conv-one": ["parent-conversation:agent-mid/default"],
    "conv-two": ["parent-conversation:agent-child/conv-child"],
    "conv-root": [],
  };
  const agents: Record<string, string[]> = {
    "agent-child": ["parent-conversation:agent-unrelated/conv-unrelated"],
    "agent-one": ["parent-conversation:agent-unrelated/conv-unrelated"],
    "agent-mid": ["parent-conversation:agent-root/conv-root"],
  };
  const reads: string[] = [];
  const backend: ParentConversationBackend = {
    retrieveConversation: async (id) => {
      reads.push(id);
      return { tags: conversations[id] };
    },
    retrieveAgent: async (id) => {
      reads.push(id);
      return { tags: agents[id] };
    },
  };
  const parents: string[] = [];
  for await (const id of getPullRequestParentConversationIds(backend, {
    agentId: "agent-child",
    conversationId: "conv-child",
  }))
    parents.push(id);
  expect(parents).toContain("conv-one");
  expect(parents).toContain("conv-two");
  expect(parents).toContain("conv-root");
  expect(parents).not.toContain("default");
  expect(parents).not.toContain("conv-unrelated");
  expect(reads).toEqual([
    "conv-child",
    "conv-one",
    "conv-two",
    "agent-mid",
    "conv-root",
  ]);
});

test("continues other parent branches when one lookup is forbidden", async () => {
  const backend: ParentConversationBackend = {
    retrieveAgent: async () => ({
      tags: [
        "parent-conversation:agent-a/conv-forbidden",
        "parent-conversation:agent-b/conv-readable",
      ],
    }),
    retrieveConversation: async (id) => {
      if (id === "conv-forbidden") throw new Error("404");
      return {
        tags:
          id === "conv-readable"
            ? ["parent-conversation:agent-root/conv-root"]
            : [],
      };
    },
  };
  const parents: string[] = [];
  for await (const id of getPullRequestParentConversationIds(backend, {
    agentId: "agent-child",
    conversationId: "default",
  }))
    parents.push(id);
  expect(parents).toEqual(["conv-forbidden", "conv-readable", "conv-root"]);
});

test("bounds traversal even when every parent has another parent", async () => {
  let reads = 0;
  const backend: ParentConversationBackend = {
    retrieveAgent: async () => ({ tags: [] }),
    retrieveConversation: async () => ({
      tags: [`parent-conversation:agent-parent/conv-${++reads}`],
    }),
  };
  for await (const _id of getPullRequestParentConversationIds(backend, {
    agentId: "agent-child",
    conversationId: "conv-start",
  })) {
    /* consume */
  }
  expect(reads).toBe(20);
});
