import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  AgentMessageListBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "../../backend";
import { FakeHeadlessBackend } from "../../backend/dev/FakeHeadlessBackend";

async function drainAssistantText(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (chunk.message_type !== "assistant_message") continue;
    const content = chunk.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        text += part.text;
      }
    }
  }
  return text;
}

function createBody(
  text: string,
  agentId: string,
): ConversationMessageCreateBody {
  return {
    messages: [{ role: "user", content: text }],
    streaming: true,
    stream_tokens: true,
    include_pings: true,
    background: true,
    client_tools: [],
    client_skills: [],
    agent_id: agentId,
  } as unknown as ConversationMessageCreateBody;
}

describe("FakeHeadlessBackend", () => {
  test("stores user and assistant messages for explicit conversations", async () => {
    const backend = new FakeHeadlessBackend("agent-test");
    const conversation = await backend.createConversation({
      agent_id: "agent-test",
    });

    const stream = await backend.createConversationMessageStream(
      conversation.id,
      createBody("hello", "agent-test"),
    );
    await expect(drainAssistantText(stream)).resolves.toBe("pong");

    const page = await backend.listConversationMessages(conversation.id, {
      order: "asc",
    } as ConversationMessageListBody);
    const messages = page.getPaginatedItems();

    expect(messages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(JSON.stringify(messages[0])).toContain("hello");
    expect(JSON.stringify(messages[1])).toContain("pong");

    const updatedConversation = (await backend.retrieveConversation(
      conversation.id,
    )) as { in_context_message_ids?: string[] };
    expect(updatedConversation.in_context_message_ids).toHaveLength(2);
  });

  test("supports default conversation listing through agent messages", async () => {
    const backend = new FakeHeadlessBackend("agent-default");

    await backend.createConversationMessageStream(
      "default",
      createBody("default hello", "agent-default"),
    );

    const page = await backend.listAgentMessages("agent-default", {
      conversation_id: "default",
      order: "asc",
    } as AgentMessageListBody);
    const messages = page.getPaginatedItems();

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(JSON.stringify(messages)).toContain("default hello");
  });

  test("appends repeated turns and paginates newest-first history", async () => {
    const backend = new FakeHeadlessBackend("agent-pages");
    const conversation = await backend.createConversation({
      agent_id: "agent-pages",
    });

    await backend.createConversationMessageStream(
      conversation.id,
      createBody("first", "agent-pages"),
    );
    await backend.createConversationMessageStream(
      conversation.id,
      createBody("second", "agent-pages"),
    );

    const firstPage = await backend.listConversationMessages(conversation.id, {
      order: "desc",
      limit: 2,
    } as ConversationMessageListBody);
    const firstPageItems = firstPage.getPaginatedItems();

    expect(firstPageItems.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "user_message",
    ]);
    expect(JSON.stringify(firstPageItems)).toContain("second");

    const secondPage = await backend.listConversationMessages(conversation.id, {
      order: "desc",
      limit: 2,
      before: firstPageItems.at(-1)?.id,
    } as ConversationMessageListBody);
    const secondPageItems = secondPage.getPaginatedItems();

    expect(secondPageItems.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "user_message",
    ]);
    expect(JSON.stringify(secondPageItems)).toContain("first");
  });
});
