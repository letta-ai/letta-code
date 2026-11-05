import { expect, test } from "bun:test";
import {
  type Context,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

// LiteLLM embeds Gemini thought signatures in tool_call ids (~180 chars).
// pi-ai caps replayed ids at 40 for provider "openai"; Letta Code keeps that
// provider id for user `openai` providers with a custom base URL, so the cap
// must only apply to real OpenAI/Azure hosts (patches/@earendil-works%2Fpi-ai).
const LONG_ID = `call_${"x".repeat(175)}`;

function openAIModel(baseUrl: string): Model<"openai-completions"> {
  return {
    id: "gemini-3-pro",
    name: "gemini-3-pro",
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

const context: Context = {
  systemPrompt: "Reply briefly.",
  messages: [
    { role: "user", content: "List files", timestamp: 1 },
    {
      role: "assistant",
      // Replayed from a different model so pi-ai normalizes the id.
      api: "openai-completions",
      provider: "litellm",
      model: "previous-model",
      content: [
        { type: "toolCall", id: LONG_ID, name: "ls", arguments: { path: "." } },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: LONG_ID,
      toolName: "ls",
      content: [{ type: "text", text: "a.txt" }],
      isError: false,
      timestamp: 3,
    },
  ],
};

async function replayedToolCallIds(baseUrl: string) {
  let payload: { messages: Array<Record<string, unknown>> } | undefined;
  const events = streamSimple(openAIModel(baseUrl), normalizeContext(context), {
    apiKey: "unused-test-key",
    // Stop after real request conversion, before any network request.
    onPayload: (request) => {
      payload = request as typeof payload;
      throw new Error("captured request without inference");
    },
  });
  for await (const _event of events) {
    // Drain until the captured-payload error ends the stream.
  }
  const assistant = payload?.messages.find((m) => m.role === "assistant") as
    | { tool_calls: Array<{ id: string }> }
    | undefined;
  const tool = payload?.messages.find((m) => m.role === "tool") as
    | { tool_call_id: string }
    | undefined;
  return { call: assistant?.tool_calls[0]?.id, result: tool?.tool_call_id };
}

test("openai-provider tool_call_id is only capped at 40 for OpenAI hosts", async () => {
  expect(await replayedToolCallIds("https://litellm.example.com/v1")).toEqual({
    call: LONG_ID,
    result: LONG_ID,
  });
  expect(await replayedToolCallIds("https://api.openai.com/v1")).toEqual({
    call: LONG_ID.slice(0, 40),
    result: LONG_ID.slice(0, 40),
  });
});
