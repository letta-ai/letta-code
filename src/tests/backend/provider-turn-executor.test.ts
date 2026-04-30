import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "../../backend";
import { FakeHeadlessBackend } from "../../backend/dev/FakeHeadlessBackend";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  type ProviderTurnInput,
} from "../../backend/dev/ProviderTurnExecutor";

function createBody(text: string): ConversationMessageCreateBody {
  return {
    messages: [{ role: "user", content: text }],
    streaming: true,
    stream_tokens: true,
    include_pings: true,
    background: true,
    client_tools: [
      {
        name: "ShellCommand",
        description: "Run a shell command",
        input_schema: { type: "object" },
      },
    ],
    client_skills: [],
    agent_id: "agent-provider",
  } as unknown as ConversationMessageCreateBody;
}

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

describe("ProviderTurnExecutor", () => {
  test("passes stored turn context to the provider adapter and maps text output", async () => {
    let captured: ProviderTurnInput | undefined;
    const adapter: ProviderStreamAdapter = {
      async *stream(input) {
        captured = input;
        yield { type: "text-delta", text: "provider ok" };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    const text = await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("hello provider"),
      ),
    );

    expect(text).toBe("provider ok");
    expect(captured?.conversationId).toBe(conversation.id);
    expect(captured?.agentId).toBe("agent-provider");
    expect(captured?.history.map((message) => message.message_type)).toEqual([
      "user_message",
    ]);
    expect(JSON.stringify(captured?.history)).toContain("hello provider");
    expect(captured?.clientTools).toHaveLength(1);

    const page = await backend.listConversationMessages(conversation.id, {
      order: "asc",
    } as ConversationMessageListBody);
    expect(
      page.getPaginatedItems().map((message) => message.message_type),
    ).toEqual(["user_message", "assistant_message"]);
  });

  test("maps provider tool calls into approval requests", async () => {
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield {
          type: "tool-call",
          toolCallId: "provider-tool-1",
          toolName: "ShellCommand",
          input: { command: "echo provider-tool", login: false },
        };
        yield { type: "finish", finishReason: "tool-calls" };
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    const chunks = await collectStream(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("call a tool"),
      ),
    );

    expect(chunks.map((chunk) => chunk.message_type)).toEqual([
      "approval_request_message",
      "stop_reason",
    ]);
    expect(JSON.stringify(chunks)).toContain("provider-tool-1");
    expect(JSON.stringify(chunks)).toContain("ShellCommand");
    expect(
      chunks.some(
        (chunk) =>
          chunk.message_type === "stop_reason" &&
          chunk.stop_reason === "requires_approval",
      ),
    ).toBe(true);

    const page = await backend.listConversationMessages(conversation.id, {
      order: "asc",
    } as ConversationMessageListBody);
    expect(
      page.getPaginatedItems().map((message) => message.message_type),
    ).toEqual(["user_message", "approval_request_message"]);
  });

  test("uses one assistant otid for text deltas in the same provider turn", async () => {
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield { type: "text-delta", text: "LET" };
        yield { type: "text-delta", text: "TA" };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    const chunks = await collectStream(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("stream text"),
      ),
    );
    const assistantChunks = chunks.filter(
      (chunk) => chunk.message_type === "assistant_message",
    ) as Array<LettaStreamingResponse & { otid?: string }>;

    expect(assistantChunks).toHaveLength(2);
    expect(assistantChunks[0]?.otid).toBeTruthy();
    expect(assistantChunks[0]?.otid).toBe(assistantChunks[1]?.otid);
  });

  test("default provider adapter stays disabled", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    const chunks = await collectStream(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("hello provider"),
      ),
    );

    expect(chunks.map((chunk) => chunk.message_type)).toEqual([
      "error_message",
      "stop_reason",
    ]);
    expect(JSON.stringify(chunks)).toContain(
      "Provider turn adapter is not configured",
    );
  });
});
