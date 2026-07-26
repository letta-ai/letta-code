import { describe, expect, test } from "bun:test";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalStore } from "@/backend/local/local-store";

describe("LocalBackend conversation forks", () => {
  test("forks through a projected message ID inclusively", () => {
    const agentId = "agent-local-fork-cutoff";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    } as unknown as ConversationMessageCreateBody);
    const sourceMessages = store.listLocalMessages(source.id, agentId);
    const projectedMessages = store.listConversationMessages(source.id, {
      agent_id: agentId,
    } as never);
    const cutoffMessageId = projectedMessages.find(
      (message) => message.id === sourceMessages[0]?.id,
    )?.id;
    if (!cutoffMessageId) throw new Error("Expected a projected message ID");

    const forked = store.forkConversation(source.id, {
      messageId: cutoffMessageId,
    });

    expect(store.listLocalMessages(forked.id, agentId)).toHaveLength(1);
  });

  test("rejects an unknown fork cutoff without creating a conversation", () => {
    const agentId = "agent-local-fork-missing-cutoff";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);

    expect(() =>
      store.forkConversation(source.id, { messageId: "missing:assistant:0" }),
    ).toThrow("Message missing:assistant:0 not found");
    expect(store.listConversations({ agent_id: agentId })).toHaveLength(1);
  });
});
