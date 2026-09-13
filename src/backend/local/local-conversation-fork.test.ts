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

  test("trims a source assistant message at the projected cutoff", () => {
    const agentId = "agent-local-fork-projected-cutoff";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendStreamChunk(source.id, agentId, {
      message_type: "reasoning_message",
      reasoning: "thinking before the answer",
    } as never);
    store.appendStreamChunk(source.id, agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "answer after the cutoff" }],
    } as never);
    const sourceProjected = store.listConversationMessages(source.id, {
      agent_id: agentId,
      order: "asc",
    } as never);
    const cutoffMessageId = sourceProjected.find(
      (message) => message.message_type === "reasoning_message",
    )?.id;
    if (!cutoffMessageId) throw new Error("Expected a reasoning message");

    const forked = store.forkConversation(source.id, {
      messageId: cutoffMessageId,
    });
    const forkedProjected = store.listConversationMessages(forked.id, {
      agent_id: agentId,
      order: "asc",
    } as never);

    expect(forkedProjected.map((message) => message.message_type)).toEqual([
      "reasoning_message",
    ]);
    expect(store.listLocalMessages(forked.id, agentId)[0]?.content).toEqual([
      expect.objectContaining({ thinking: "thinking before the answer" }),
    ]);
  });

  test("rejects a fabricated projected ID for an existing source message", () => {
    const agentId = "agent-local-fork-invalid-projection";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    } as unknown as ConversationMessageCreateBody);
    const sourceMessageId = store.listLocalMessages(source.id, agentId)[0]?.id;
    if (!sourceMessageId) throw new Error("Expected a source message");

    expect(() =>
      store.forkConversation(source.id, {
        messageId: `${sourceMessageId}:assistant:999`,
      }),
    ).toThrow(`Message ${sourceMessageId}:assistant:999 not found`);
    expect(store.listConversations({ agent_id: agentId })).toHaveLength(1);
  });
});
