import { expect, test } from "bun:test";
import { getParentConversationScopes } from "./parent-conversation";

test("reads exact parent scope pairs and deduplicates them", () => {
  expect(
    getParentConversationScopes([
      "parent-conversation:agent-one/conv-one",
      "parent-conversation:agent-one/conv-one",
      "parent-conversation:agent-one/default",
      "parent-conversation:agent-two/default",
      "parent-conversation:agent-two/conv-one",
      "channel:slack",
      "parent-agent:agent-unrelated",
      "parent-conversation:conv-missing-agent",
      "parent-conversation:agent-one/",
      "parent-conversation:agent-one/conv-one/extra",
      "parent-conversation:agent-one/other",
      "parent-conversation:agent-one/conv has space",
    ]),
  ).toEqual([
    { agentId: "agent-one", conversationId: "conv-one" },
    { agentId: "agent-one", conversationId: "default" },
    { agentId: "agent-two", conversationId: "default" },
    { agentId: "agent-two", conversationId: "conv-one" },
  ]);
});
