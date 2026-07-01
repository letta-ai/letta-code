import { describe, expect, test } from "bun:test";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { buildConversationModelCarryoverUpdate } from "@/agent/conversation-model-carryover";

describe("conversation model carryover", () => {
  test("seeds new conversations with the model preset context window before stale llm_config", () => {
    const carryover = buildConversationModelCarryoverUpdate({
      rawModelHandle: "chatgpt_oauth/gpt-5.5",
      currentLlmConfig: {
        model: "gpt-5.5",
        model_endpoint_type: "chatgpt_oauth",
        reasoning_effort: "xhigh",
        context_window: 128000,
      } as LlmConfig,
      activeConversationContextWindowLimit: null,
    });

    expect(carryover?.modelHandle).toBe("chatgpt-plus-pro/gpt-5.5");
    expect(carryover?.updateArgs).toMatchObject({
      reasoning_effort: "xhigh",
      context_window: 272000,
      max_output_tokens: 128000,
      parallel_tool_calls: true,
    });
  });

  test("preserves an explicit active conversation context window", () => {
    const carryover = buildConversationModelCarryoverUpdate({
      rawModelHandle: "chatgpt_oauth/gpt-5.5",
      currentLlmConfig: {
        model: "gpt-5.5",
        model_endpoint_type: "chatgpt_oauth",
        reasoning_effort: "xhigh",
        context_window: 128000,
      } as LlmConfig,
      activeConversationContextWindowLimit: 100000,
    });

    expect(carryover?.updateArgs).toMatchObject({
      reasoning_effort: "xhigh",
      context_window: 100000,
    });
  });

  test("uses centralized normalization for ChatGPT fast handles", () => {
    const carryover = buildConversationModelCarryoverUpdate({
      rawModelHandle: "chatgpt_oauth/gpt-5.5-fast",
      currentLlmConfig: {
        model: "gpt-5.5-fast",
        model_endpoint_type: "chatgpt_oauth",
        reasoning_effort: "high",
      } as LlmConfig,
      activeConversationContextWindowLimit: null,
    });

    expect(carryover?.modelHandle).toBe("chatgpt-plus-pro/gpt-5.5-fast");
    expect(carryover?.updateArgs).toMatchObject({
      reasoning_effort: "high",
      context_window: 272000,
    });
  });

  test("does not copy stale llm_config context when the model preset is unknown", () => {
    const carryover = buildConversationModelCarryoverUpdate({
      rawModelHandle: "openai/custom-model",
      currentLlmConfig: {
        model: "custom-model",
        model_endpoint_type: "openai",
        context_window: 128000,
      } as LlmConfig,
      activeConversationContextWindowLimit: null,
    });

    expect(carryover?.modelHandle).toBe("openai/custom-model");
    expect(carryover?.updateArgs).toBeUndefined();
  });

  test("does not carry over stale OpenAI provider for Anthropic Sonnet", () => {
    const carryover = buildConversationModelCarryoverUpdate({
      rawModelHandle: "openai/claude-sonnet-4-6",
      currentLlmConfig: {
        model: "claude-sonnet-4-6",
        model_endpoint_type: "openai",
      } as LlmConfig,
      activeConversationContextWindowLimit: null,
    });

    expect(carryover?.modelHandle).toBe("anthropic/claude-sonnet-4-6");
    expect(carryover?.updateArgs).toMatchObject({
      context_window: 200000,
      max_output_tokens: 128000,
      reasoning_effort: "high",
      enable_reasoner: true,
    });
  });
});
