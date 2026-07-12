import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { HeadlessTurnExecutorInput } from "@/backend/dev/headless-turn-executor";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  providerLocalMessage,
  providerStreamPart,
} from "@/backend/dev/provider-turn-executor";
import {
  emptyLocalUsage,
  type LocalMessage,
} from "@/backend/local/local-message";
import {
  getAttachedLocalMessage,
  isLocalStateChunkOnly,
  type ProviderStreamPart,
} from "@/backend/local/local-stream-chunks";

function part(value: Record<string, unknown>): ProviderStreamPart {
  return value as unknown as ProviderStreamPart;
}

function input(): HeadlessTurnExecutorInput {
  return {
    conversationId: "local-conv-1",
    agentId: "agent-local-1",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "",
      tags: [],
      model: "openai/gpt-5.5",
      model_settings: {},
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [],
  };
}

async function collect(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function assistantMessage(usage = emptyLocalUsage()): LocalMessage {
  return {
    id: "local-assistant-final",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("ProviderTurnExecutor", () => {
  test("maps pi text, thinking, tool call, usage, and done events", async () => {
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        const message = assistantMessage();
        yield providerStreamPart(
          part({
            type: "text_delta",
            contentIndex: 0,
            delta: "hello",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "thinking_delta",
            contentIndex: 1,
            delta: "think",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "toolcall_end",
            contentIndex: 2,
            toolCall: {
              type: "toolCall",
              id: "call-1",
              name: "Read",
              arguments: { path: "README.md" },
            },
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({ type: "done", reason: "toolUse", message }),
        );
      },
    };

    const chunks = await collect(
      await new ProviderTurnExecutor(adapter).execute(input()),
    );
    expect(chunks.map((chunk) => chunk.message_type)).toEqual([
      "assistant_message",
      "reasoning_message",
      "approval_request_message",
      "usage_statistics",
      "stop_reason",
    ]);
    expect(
      (chunks.at(-1) as { stop_reason?: string } | undefined)?.stop_reason,
    ).toBe("requires_approval");
  });

  test("groups adjacent live blocks and preserves interleaved boundaries", async () => {
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        const message = {
          ...assistantMessage(),
          content: [
            { type: "text" as const, text: "first-a" },
            { type: "text" as const, text: "first-b" },
            { type: "thinking" as const, thinking: "think-a" },
            { type: "thinking" as const, thinking: "think-b" },
            { type: "text" as const, text: "second" },
            { type: "thinking" as const, thinking: "think-c" },
          ],
        };
        yield providerStreamPart(
          part({
            type: "text_delta",
            contentIndex: 0,
            delta: "first-a",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "text_delta",
            contentIndex: 1,
            delta: "first-b",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "text_delta",
            contentIndex: 4,
            delta: "second",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "thinking_delta",
            contentIndex: 2,
            delta: "think-a",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "thinking_delta",
            contentIndex: 3,
            delta: "think-b",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({
            type: "thinking_delta",
            contentIndex: 5,
            delta: "think-c",
            partial: message,
          }),
        );
        yield providerStreamPart(
          part({ type: "done", reason: "stop", message }),
        );
      },
    };

    const chunks = await collect(
      await new ProviderTurnExecutor(adapter).execute(input()),
    );
    const assistantOtids = chunks
      .filter((chunk) => chunk.message_type === "assistant_message")
      .map((chunk) => (chunk as { otid?: string }).otid);
    expect(assistantOtids[0]).toBe(assistantOtids[1]);
    expect(assistantOtids[0]).not.toBe(assistantOtids[2]);

    const reasoningOtids = chunks
      .filter((chunk) => chunk.message_type === "reasoning_message")
      .map((chunk) => (chunk as { otid?: string }).otid);
    expect(reasoningOtids[0]).toBe(reasoningOtids[1]);
    expect(reasoningOtids[0]).not.toBe(reasoningOtids[2]);
  });

  test("emits final local assistant messages as state-only chunks before stop_reason", async () => {
    const finalMessage = assistantMessage();
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield providerLocalMessage(finalMessage);
        yield providerStreamPart(
          part({ type: "done", reason: "stop", message: finalMessage }),
        );
      },
    };

    const chunks = await collect(
      await new ProviderTurnExecutor(adapter).execute(input()),
    );
    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["local_message", "usage_statistics", "stop_reason"]);
    expect(isLocalStateChunkOnly(chunks[0])).toBe(true);
    expect(getAttachedLocalMessage(chunks[0])).toEqual(finalMessage);
    expect(
      (chunks.at(-1) as { stop_reason?: string } | undefined)?.stop_reason,
    ).toBe("end_turn");
  });

  test("emits estimated context_tokens when provider usage is empty", async () => {
    const finalMessage = assistantMessage();
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield providerStreamPart(
          part({ type: "done", reason: "stop", message: finalMessage }),
        );
      },
    };

    const turnInput = input();
    turnInput.systemPrompt = "You are a local coding agent.";
    turnInput.uiMessages = [
      {
        id: "local-user-1",
        role: "user",
        content: "Please inspect the repository and summarize the build.",
        timestamp: Date.now(),
      },
    ];
    turnInput.body = {
      messages: [{ role: "user", content: "Please inspect the repository." }],
      client_tools: [
        {
          name: "Read",
          description: "Read a file",
          parameters: { type: "object" },
        },
      ],
    } as never;

    const chunks = await collect(
      await new ProviderTurnExecutor(adapter).execute(turnInput),
    );
    const usage = chunks.find(
      (chunk) => chunk.message_type === "usage_statistics",
    ) as { context_tokens?: number; total_tokens?: number } | undefined;

    expect(usage?.total_tokens).toBe(0);
    expect(usage?.context_tokens).toBeGreaterThan(0);
  });

  test("uses latest total_tokens for context_tokens when provider reports usage", async () => {
    const finalMessage = assistantMessage({
      input: 100,
      output: 900,
      cacheRead: 20,
      cacheWrite: 5,
      totalTokens: 1025,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield providerStreamPart(
          part({ type: "done", reason: "stop", message: finalMessage }),
        );
      },
    };

    const chunks = await collect(
      await new ProviderTurnExecutor(adapter).execute(input()),
    );
    const usage = chunks.find(
      (chunk) => chunk.message_type === "usage_statistics",
    ) as { context_tokens?: number; total_tokens?: number } | undefined;

    expect(usage?.total_tokens).toBe(1025);
    expect(usage?.context_tokens).toBe(1025);
  });

  test("normalizes provider errors into local error chunks", async () => {
    const adapter: ProviderStreamAdapter = {
      async *stream() {
        yield { type: "error", error: new Error("provider exploded") };
      },
    };

    const chunks = await collect(
      await new ProviderTurnExecutor(adapter).execute(input()),
    );
    expect(chunks.map((chunk) => chunk.message_type)).toEqual([
      "error_message",
      "stop_reason",
    ]);
    expect(JSON.stringify(chunks)).toContain("provider exploded");
  });
});
