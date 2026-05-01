import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  AgentCreateBody,
  AgentMessageListBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "../../backend";
import { FakeHeadlessBackend } from "../../backend/dev/FakeHeadlessBackend";
import { DeterministicToolCallExecutor } from "../../backend/dev/HeadlessTurnExecutor";

async function collectStream(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

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
  test("creates agents and lists local models through the backend facade", async () => {
    const backend = new FakeHeadlessBackend("agent-default");
    expect(backend.capabilities.remoteMemfs).toBe(false);

    const agent = await backend.createAgent({
      name: "Created Agent",
      system: "system prompt",
      model: "dev/fake-headless",
      tools: ["web_search"],
      tags: ["origin:test"],
    } as AgentCreateBody);
    const retrieved = await backend.retrieveAgent(agent.id);
    const models = await backend.listModels();

    expect(agent.id).toBe("agent-fake-headless-1");
    expect(retrieved.name).toBe("Created Agent");
    expect(retrieved.system).toBe("system prompt");
    expect(retrieved.tools?.map((tool) => tool.name)).toEqual(["web_search"]);
    expect(retrieved.tags).toEqual(["origin:test"]);
    expect(models.map((model) => model.handle)).toEqual(["dev/fake-headless"]);
  });

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

    await drainAssistantText(
      await backend.createConversationMessageStream(
        "default",
        createBody("default hello", "agent-default"),
      ),
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

    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("first", "agent-pages"),
      ),
    );
    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("second", "agent-pages"),
      ),
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

  test("persists deterministic tool request and approval-result output", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-tool",
      new DeterministicToolCallExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-tool",
    });

    const firstChunks = await collectStream(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("use a tool", "agent-tool"),
      ),
    );
    const approvalChunk = firstChunks.find(
      (chunk) => chunk.message_type === "approval_request_message",
    ) as
      | (LettaStreamingResponse & {
          tool_call?: { tool_call_id?: string; name?: string };
        })
      | undefined;
    expect(approvalChunk?.tool_call?.name).toBe("ShellCommand");
    expect(
      firstChunks.some(
        (chunk) =>
          chunk.message_type === "stop_reason" &&
          chunk.stop_reason === "requires_approval",
      ),
    ).toBe(true);

    const afterRequest = await backend.listConversationMessages(
      conversation.id,
      { order: "asc" } as ConversationMessageListBody,
    );
    expect(
      afterRequest.getPaginatedItems().map((message) => message.message_type),
    ).toEqual(["user_message", "approval_request_message"]);

    const finalText = await drainAssistantText(
      await backend.createConversationMessageStream(conversation.id, {
        ...createBody("", "agent-tool"),
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: approvalChunk?.tool_call?.tool_call_id,
                tool_return: "deterministic-tool-ok",
                status: "success",
              },
            ],
          },
        ],
      } as unknown as ConversationMessageCreateBody),
    );
    expect(finalText).toContain("tool result received (success)");
    expect(finalText).toContain("deterministic-tool-ok");

    const afterApproval = await backend.listConversationMessages(
      conversation.id,
      { order: "asc" } as ConversationMessageListBody,
    );
    expect(
      afterApproval.getPaginatedItems().map((message) => message.message_type),
    ).toEqual([
      "user_message",
      "approval_request_message",
      "approval_response_message",
      "assistant_message",
    ]);
  });
});
