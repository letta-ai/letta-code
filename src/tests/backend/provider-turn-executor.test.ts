import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "../../backend";
import { FakeHeadlessBackend } from "../../backend/dev/FakeHeadlessBackend";
import type { ProviderStreamPart } from "../../backend/dev/ProviderTrajectory";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  type ProviderTurnInput,
  providerStreamPart,
  providerUIMessage,
} from "../../backend/dev/ProviderTurnExecutor";

function streamPart(part: Record<string, unknown>) {
  return providerStreamPart(part as ProviderStreamPart);
}

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
        yield streamPart({
          type: "text-delta",
          id: "text-1",
          text: "provider ok",
        });
        yield streamPart({ type: "finish", finishReason: "stop" });
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
    expect(
      captured?.uiMessages.map((message) => ({
        role: message.role,
        parts: message.parts,
      })),
    ).toEqual([
      { role: "user", parts: [{ type: "text", text: "hello provider" }] },
    ]);
    expect(captured?.providerTrajectory[0]?.type).toBe(
      "letta_provider_ui_message",
    );
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
        yield streamPart({
          type: "tool-call",
          toolCallId: "provider-tool-1",
          toolName: "ShellCommand",
          input: { command: "echo provider-tool", login: false },
        });
        yield streamPart({ type: "finish", finishReason: "tool-calls" });
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

  test("passes AI SDK provider trajectory through tool-call continuations", async () => {
    const capturedMessages: ProviderTurnInput["uiMessages"][] = [];
    const adapter: ProviderStreamAdapter = {
      async *stream(input) {
        capturedMessages.push(input.uiMessages);
        const hasToolResult = input.uiMessages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) =>
                part.type === "tool-ShellCommand" &&
                "state" in part &&
                part.state === "output-available",
            ),
        );
        if (!hasToolResult) {
          yield streamPart({
            type: "tool-call",
            toolCallId: "provider-tool-trajectory",
            toolName: "ShellCommand",
            input: { command: "echo provider-trajectory", login: false },
          });
          yield streamPart({ type: "finish", finishReason: "tool-calls" });
          return;
        }
        yield streamPart({
          type: "text-delta",
          id: "text-1",
          text: "trajectory ok",
        });
        yield streamPart({ type: "finish", finishReason: "stop" });
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    const firstChunks = await collectStream(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("call a trajectory tool"),
      ),
    );
    const approvalChunk = firstChunks.find(
      (chunk) => chunk.message_type === "approval_request_message",
    ) as LettaStreamingResponse & {
      tool_call?: { tool_call_id?: string };
    };
    expect(approvalChunk.tool_call?.tool_call_id).toBe(
      "provider-tool-trajectory",
    );

    const finalText = await drainAssistantText(
      await backend.createConversationMessageStream(conversation.id, {
        ...createBody(""),
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: approvalChunk.tool_call?.tool_call_id,
                tool_return: "provider-trajectory",
                status: "success",
              },
            ],
          },
        ],
      } as unknown as ConversationMessageCreateBody),
    );

    expect(finalText).toBe("trajectory ok");
    expect(
      capturedMessages[0]?.map((message) => ({
        role: message.role,
        parts: message.parts,
      })),
    ).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "call a trajectory tool" }],
      },
    ]);
    expect(
      capturedMessages[1]?.map((message) => ({
        role: message.role,
        parts: message.parts,
      })),
    ).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "call a trajectory tool" }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-ShellCommand",
            toolCallId: "provider-tool-trajectory",
            state: "output-available",
            input: { command: "echo provider-trajectory", login: false },
            output: "provider-trajectory",
          },
        ],
      },
    ]);
  });

  test("represents denied approvals as output-error UI tool parts", async () => {
    const capturedMessages: ProviderTurnInput["uiMessages"][] = [];
    const adapter: ProviderStreamAdapter = {
      async *stream(input) {
        capturedMessages.push(input.uiMessages);
        if (
          input.uiMessages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some(
                (part) =>
                  part.type === "tool-ShellCommand" &&
                  "state" in part &&
                  part.state === "output-error",
              ),
          )
        ) {
          yield streamPart({
            type: "text-delta",
            id: "text-1",
            text: "denied ok",
          });
          yield streamPart({ type: "finish", finishReason: "stop" });
          return;
        }
        yield streamPart({
          type: "tool-call",
          toolCallId: "provider-tool-denied",
          toolName: "ShellCommand",
          input: { command: "node -e unsafe" },
        });
        yield streamPart({ type: "finish", finishReason: "tool-calls" });
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
        createBody("call denied tool"),
      ),
    );
    const approvalChunk = chunks.find(
      (chunk) => chunk.message_type === "approval_request_message",
    ) as LettaStreamingResponse & {
      tool_call?: { tool_call_id?: string };
    };

    await drainAssistantText(
      await backend.createConversationMessageStream(conversation.id, {
        ...createBody(""),
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "approval",
                tool_call_id: approvalChunk.tool_call?.tool_call_id,
                approve: false,
                reason: "Tool requires approval (headless mode)",
              },
            ],
          },
        ],
      } as unknown as ConversationMessageCreateBody),
    );

    expect(capturedMessages[1]?.at(-1)?.parts.at(-1)).toEqual({
      type: "tool-ShellCommand",
      toolCallId: "provider-tool-denied",
      state: "output-error",
      input: { command: "node -e unsafe" },
      errorText: "Tool requires approval (headless mode)",
    });
  });

  test("uses one assistant otid for text deltas in the same provider turn", async () => {
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield streamPart({ type: "text-delta", id: "text-1", text: "LET" });
        yield streamPart({ type: "text-delta", id: "text-1", text: "TA" });
        yield streamPart({ type: "finish", finishReason: "stop" });
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

  test("persists reasoning deltas in the provider UI trajectory", async () => {
    const capturedMessages: ProviderTurnInput["uiMessages"][] = [];
    let turn = 0;
    const adapter: ProviderStreamAdapter = {
      async *stream(input) {
        capturedMessages.push(input.uiMessages);
        turn += 1;
        if (turn === 1) {
          yield streamPart({
            type: "reasoning-delta",
            id: "reasoning-1",
            text: "think",
          });
          yield streamPart({ type: "text-delta", id: "text-1", text: "done" });
        }
        yield streamPart({ type: "finish", finishReason: "stop" });
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("reason first"),
      ),
    );
    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("reason second"),
      ),
    );

    expect(
      capturedMessages[1]?.map((message) => ({
        role: message.role,
        parts: message.parts,
      })),
    ).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "reason first" }],
      },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "think" },
          { type: "text", text: "done" },
        ],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "reason second" }],
      },
    ]);
  });

  test("uses AI SDK UIMessage snapshots as the provider trajectory source", async () => {
    const capturedMessages: ProviderTurnInput["uiMessages"][] = [];
    let turn = 0;
    const adapter: ProviderStreamAdapter = {
      async *stream(input) {
        capturedMessages.push(input.uiMessages);
        turn += 1;
        if (turn === 1) {
          yield streamPart({
            type: "text-delta",
            id: "text-1",
            text: "sdk ok",
          });
          yield streamPart({ type: "finish", finishReason: "stop" });
          yield providerUIMessage({
            id: "sdk-response-message",
            role: "assistant",
            parts: [{ type: "text", text: "sdk ok", state: "done" }],
          });
          return;
        }
        yield streamPart({ type: "finish", finishReason: "stop" });
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("sdk first"),
      ),
    );
    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("sdk second"),
      ),
    );

    expect(
      capturedMessages[1]?.map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts,
      })),
    ).toEqual([
      {
        id: "provider-msg-fake-headless-1",
        role: "user",
        parts: [{ type: "text", text: "sdk first" }],
      },
      {
        id: "provider-msg-fake-headless-2",
        role: "assistant",
        parts: [{ type: "text", text: "sdk ok", state: "done" }],
      },
      {
        id: "provider-msg-fake-headless-3",
        role: "user",
        parts: [{ type: "text", text: "sdk second" }],
      },
    ]);
  });

  test("preserves full provider stream parts in the raw trajectory sidecar", async () => {
    const capturedTrajectories: ProviderTurnInput["providerTrajectory"][] = [];
    let turn = 0;
    const adapter: ProviderStreamAdapter = {
      async *stream(input) {
        capturedTrajectories.push(input.providerTrajectory);
        turn += 1;
        if (turn === 1) {
          yield streamPart({
            type: "start-step",
            request: { body: { input: "raw first" } },
            warnings: [{ type: "other", message: "raw warning" }],
          });
          yield streamPart({
            type: "text-start",
            id: "text-raw",
            providerMetadata: { openai: { itemId: "item-text" } },
          });
          yield streamPart({
            type: "text-delta",
            id: "text-raw",
            text: "raw hello",
            providerMetadata: { openai: { itemId: "item-text" } },
          });
          yield streamPart({
            type: "text-end",
            id: "text-raw",
            providerMetadata: { openai: { itemId: "item-text" } },
          });
          yield streamPart({
            type: "raw",
            rawValue: { type: "response.output_text.delta" },
          });
          yield streamPart({
            type: "finish-step",
            response: {
              id: "resp-raw-1",
              timestamp: new Date(Date.UTC(2026, 0, 1)),
              modelId: "gpt-test",
            },
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            finishReason: "stop",
            rawFinishReason: "stop",
            providerMetadata: { openai: { responseId: "resp-raw-1" } },
          });
        }
        yield streamPart({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
      },
    };
    const backend = new FakeHeadlessBackend(
      "agent-provider",
      new ProviderTurnExecutor(adapter),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-provider",
    });

    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("raw first"),
      ),
    );
    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("raw second"),
      ),
    );

    const assistantEntry = capturedTrajectories[1]?.find(
      (entry) => entry.uiMessage.role === "assistant",
    );
    expect(
      assistantEntry?.raw?.streamParts?.map(
        (part) => (part as { type?: unknown }).type,
      ),
    ).toEqual([
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "raw",
      "finish-step",
      "finish",
    ]);
    expect(assistantEntry?.raw?.request).toEqual({
      body: { input: "raw first" },
    });
    expect(assistantEntry?.raw?.response).toMatchObject({
      id: "resp-raw-1",
      modelId: "gpt-test",
    });
    expect(assistantEntry?.raw?.providerMetadata).toEqual({
      openai: { responseId: "resp-raw-1" },
    });
    expect(assistantEntry?.uiMessage.metadata?.provider).toEqual({
      model_id: "gpt-test",
      response_id: "resp-raw-1",
      provider_metadata: { openai: { responseId: "resp-raw-1" } },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(assistantEntry?.uiMessage.parts).toEqual([
      {
        type: "text",
        text: "raw hello",
        state: "done",
        providerMetadata: { openai: { itemId: "item-text" } },
      },
    ]);
  });

  test("reloads provider UI trajectory from flatfile storage", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "letta-provider-store-"));
    try {
      const firstAdapter: ProviderStreamAdapter = {
        async *stream() {
          yield streamPart({
            type: "tool-call",
            toolCallId: "provider-tool-persisted",
            toolName: "ShellCommand",
            input: { command: "echo persisted", login: false },
          });
          yield streamPart({ type: "finish", finishReason: "tool-calls" });
        },
      };
      const firstBackend = new FakeHeadlessBackend(
        "agent-provider",
        new ProviderTurnExecutor(firstAdapter),
        { storageDir },
      );
      const conversation = await firstBackend.createConversation({
        agent_id: "agent-provider",
      });

      const firstChunks = await collectStream(
        await firstBackend.createConversationMessageStream(
          conversation.id,
          createBody("call persisted tool"),
        ),
      );
      const approvalChunk = firstChunks.find(
        (chunk) => chunk.message_type === "approval_request_message",
      ) as LettaStreamingResponse & {
        tool_call?: { tool_call_id?: string };
      };

      let capturedMessages: ProviderTurnInput["uiMessages"] | undefined;
      const secondAdapter: ProviderStreamAdapter = {
        async *stream(input) {
          capturedMessages = input.uiMessages;
          yield streamPart({
            type: "text-delta",
            id: "text-1",
            text: "persisted trajectory ok",
          });
          yield streamPart({ type: "finish", finishReason: "stop" });
        },
      };
      const secondBackend = new FakeHeadlessBackend(
        "agent-provider",
        new ProviderTurnExecutor(secondAdapter),
        { storageDir },
      );

      const finalText = await drainAssistantText(
        await secondBackend.createConversationMessageStream(conversation.id, {
          ...createBody(""),
          messages: [
            {
              type: "approval",
              approvals: [
                {
                  type: "tool",
                  tool_call_id: approvalChunk.tool_call?.tool_call_id,
                  tool_return: "persisted-result",
                  status: "success",
                },
              ],
            },
          ],
        } as unknown as ConversationMessageCreateBody),
      );

      expect(finalText).toBe("persisted trajectory ok");
      expect(
        capturedMessages?.map((message) => ({
          role: message.role,
          parts: message.parts,
        })),
      ).toEqual([
        {
          role: "user",
          parts: [{ type: "text", text: "call persisted tool" }],
        },
        {
          role: "assistant",
          parts: [
            {
              type: "tool-ShellCommand",
              toolCallId: "provider-tool-persisted",
              state: "output-available",
              input: { command: "echo persisted", login: false },
              output: "persisted-result",
            },
          ],
        },
      ]);

      const page = await secondBackend.listConversationMessages(
        conversation.id,
        { order: "asc" } as ConversationMessageListBody,
      );
      expect(
        page.getPaginatedItems().map((message) => message.message_type),
      ).toEqual([
        "user_message",
        "approval_request_message",
        "approval_response_message",
        "assistant_message",
      ]);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
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
