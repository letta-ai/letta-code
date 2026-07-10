import { describe, expect, test } from "bun:test";

import {
  getChatGptFastRegistryHandleForModelHandle,
  getModelInfo,
  getModelInfoForLlmConfig,
  getReasoningTierOptionsForHandle,
  shouldPreserveContextWindowForModelSelection,
} from "@/agent/model";

describe("getModelInfo", () => {
  test("points opus alias at Opus 4.8 high", () => {
    const info = getModelInfo("opus");
    expect(info?.handle).toBe("anthropic/claude-opus-4-8");
    expect(info?.label).toBe("Opus 4.8");
    expect(info?.updateArgs).toMatchObject({
      context_window: 200000,
      reasoning_effort: "high",
      enable_reasoner: true,
    });
  });

  test("resolves Fable 5 registry metadata", () => {
    const info = getModelInfo("fable");
    expect(info?.handle).toBe("anthropic/claude-fable-5");
    expect(info?.label).toBe("Fable 5");
    expect(info?.updateArgs).toMatchObject({
      context_window: 200000,
      max_output_tokens: 128000,
      enable_reasoner: true,
      reasoning_effort: "high",
      parallel_tool_calls: true,
    });
  });

  test("resolves Fable 5 1M registry metadata", () => {
    const info = getModelInfo("fable-1m");
    expect(info?.handle).toBe("anthropic/claude-fable-5");
    expect(info?.label).toBe("Fable 5 1M");
    expect(info?.updateArgs).toMatchObject({
      context_window: 950000,
      max_output_tokens: 128000,
      enable_reasoner: true,
      reasoning_effort: "high",
      parallel_tool_calls: true,
    });
  });

  test("preserves Bedrock Opus 4.7", () => {
    const info = getModelInfo("bedrock-opus-4.7");
    expect(info?.handle).toBe("bedrock/us.anthropic.claude-opus-4-7");
    expect(info?.label).toBe("Bedrock Opus 4.7");
    expect(info?.updateArgs).toMatchObject({
      context_window: 200000,
      reasoning_effort: "medium",
      enable_reasoner: true,
    });
  });

  test("resolves MiniMax M3 registry metadata", () => {
    const info = getModelInfo("minimax-m3");
    expect(info?.handle).toBe("minimax/MiniMax-M3");
    expect(info?.label).toBe("MiniMax M3");
    expect(info?.updateArgs).toMatchObject({
      context_window: 500000,
      parallel_tool_calls: true,
    });
  });

  test("resolves direct xAI Grok 4.5 registry metadata", () => {
    const info = getModelInfo("grok-4.5");
    expect(info?.handle).toBe("xai/grok-4.5");
    expect(info?.label).toBe("Grok 4.5");
    expect(info?.updateArgs).toMatchObject({
      context_window: 500000,
      max_output_tokens: 16384,
      parallel_tool_calls: true,
    });
  });
});

describe("getModelInfoForLlmConfig", () => {
  test("selects gpt-5.4 tier by reasoning_effort", () => {
    const handle = "openai/gpt-5.4";

    const high = getModelInfoForLlmConfig(handle, { reasoning_effort: "high" });
    expect(high?.id).toBe("gpt-5.4-high");

    const none = getModelInfoForLlmConfig(handle, { reasoning_effort: "none" });
    expect(none?.id).toBe("gpt-5.4-none");

    const xhigh = getModelInfoForLlmConfig(handle, {
      reasoning_effort: "xhigh",
    });
    expect(xhigh?.id).toBe("gpt-5.4-xhigh");
  });

  test("selects gpt-5.6 sol tier by reasoning_effort", () => {
    const handle = "openai/gpt-5.6-sol";

    const high = getModelInfoForLlmConfig(handle, { reasoning_effort: "high" });
    expect(high?.id).toBe("gpt-5.6-sol");

    const none = getModelInfoForLlmConfig(handle, { reasoning_effort: "none" });
    expect(none?.id).toBe("gpt-5.6-sol-none");

    const xhigh = getModelInfoForLlmConfig(handle, {
      reasoning_effort: "xhigh",
    });
    expect(xhigh?.id).toBe("gpt-5.6-sol-xhigh");

    const max = getModelInfoForLlmConfig(handle, {
      reasoning_effort: "max",
    });
    expect(max?.id).toBe("gpt-5.6-sol-max");
  });

  test("uses ChatGPT metadata for local ChatGPT OAuth handles", () => {
    const info = getModelInfoForLlmConfig("openai-codex/gpt-5.5", {
      reasoning_effort: "high",
    });
    expect(info?.id).toBe("gpt-5.5-plus-pro-high");
    expect(info?.label).toBe("GPT-5.5 (ChatGPT)");
  });

  test("uses Fast ChatGPT metadata when local ChatGPT service tier is priority", () => {
    const info = getModelInfoForLlmConfig("openai-codex/gpt-5.5", {
      reasoning_effort: "high",
      service_tier: "priority",
    });
    expect(info?.id).toBe("gpt-5.5-fast-plus-pro-high");
    expect(info?.label).toBe("GPT-5.5 Fast (ChatGPT)");
  });

  test("does not treat synthetic local ChatGPT Fast handles as registry models", () => {
    const info = getModelInfoForLlmConfig("openai-codex/gpt-5.5-fast", {
      reasoning_effort: "high",
    });
    expect(info).toBeNull();
  });

  test("falls back to first handle match when effort missing", () => {
    const handle = "openai/gpt-5.4";
    const info = getModelInfoForLlmConfig(handle, null);
    // models.json order currently lists gpt-5.4-none first.
    expect(info?.id).toBe("gpt-5.4-none");
  });

  test("selects opus 1M variant by context_window", () => {
    const handle = "anthropic/claude-opus-4-8";

    const withEffort = getModelInfoForLlmConfig(handle, {
      context_window: 950000,
      reasoning_effort: "high",
    });
    expect(withEffort?.id).toBe("opus-4.8-1m");

    // With 1M context_window but no effort → still a 1M variant (not 200k "opus")
    const noEffort = getModelInfoForLlmConfig(handle, {
      context_window: 950000,
    });
    expect(noEffort?.id).not.toBe("opus");
    expect(
      (noEffort?.updateArgs as { context_window?: number })?.context_window,
    ).toBe(950000);
  });

  test("keeps existing opus 4.6 1M variant ids stable", () => {
    const info = getModelInfoForLlmConfig("anthropic/claude-opus-4-6", {
      context_window: 950000,
      reasoning_effort: "high",
    });
    expect(info?.id).toBe("opus-1m");
    expect(info?.label).toBe("Opus 4.6 1M");
  });

  test("selects sonnet 1M variant by context_window", () => {
    const handle = "anthropic/claude-sonnet-4-6";

    const withEffort = getModelInfoForLlmConfig(handle, {
      context_window: 9500000,
      reasoning_effort: "high",
    });
    expect(withEffort?.id).toBe("sonnet-1m");

    const noEffort = getModelInfoForLlmConfig(handle, {
      context_window: 9500000,
    });
    expect(noEffort?.id).not.toBe("sonnet");
    expect(
      (noEffort?.updateArgs as { context_window?: number })?.context_window,
    ).toBe(9500000);
  });
});

describe("getReasoningTierOptionsForHandle", () => {
  test("returns ordered reasoning options for gpt-5.4", () => {
    const options = getReasoningTierOptionsForHandle("openai/gpt-5.4");
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.4-none",
      "gpt-5.4-low",
      "gpt-5.4-medium",
      "gpt-5.4-high",
      "gpt-5.4-xhigh",
    ]);
  });

  test("returns ordered reasoning options for gpt-5.6 sol", () => {
    const options = getReasoningTierOptionsForHandle("openai/gpt-5.6-sol");
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.6-sol-none",
      "gpt-5.6-sol-low",
      "gpt-5.6-sol-medium",
      "gpt-5.6-sol",
      "gpt-5.6-sol-xhigh",
      "gpt-5.6-sol-max",
    ]);
  });

  test("returns ordered reasoning options for gpt-5.3-codex", () => {
    const options = getReasoningTierOptionsForHandle("openai/gpt-5.3-codex");
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.3-codex-none",
      "gpt-5.3-codex-low",
      "gpt-5.3-codex-medium",
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-xhigh",
    ]);
  });

  test("returns byok reasoning options for chatgpt-plus-pro gpt-5.5", () => {
    const options = getReasoningTierOptionsForHandle(
      "chatgpt-plus-pro/gpt-5.5",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.5-plus-pro-none",
      "gpt-5.5-plus-pro-low",
      "gpt-5.5-plus-pro-medium",
      "gpt-5.5-plus-pro-high",
      "gpt-5.5-plus-pro-xhigh",
    ]);
  });

  test("returns ChatGPT reasoning options for local ChatGPT OAuth gpt-5.5", () => {
    const options = getReasoningTierOptionsForHandle("openai-codex/gpt-5.5");
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.5-plus-pro-none",
      "gpt-5.5-plus-pro-low",
      "gpt-5.5-plus-pro-medium",
      "gpt-5.5-plus-pro-high",
      "gpt-5.5-plus-pro-xhigh",
    ]);
  });

  test("returns distinct xhigh and max options for local ChatGPT OAuth GPT-5.6", () => {
    const options = getReasoningTierOptionsForHandle(
      "openai-codex/gpt-5.6-sol",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.6-sol-plus-pro-none",
      "gpt-5.6-sol-plus-pro-low",
      "gpt-5.6-sol-plus-pro-medium",
      "gpt-5.6-sol-plus-pro-high",
      "gpt-5.6-sol-plus-pro-xhigh",
      "gpt-5.6-sol-plus-pro-max",
    ]);
  });

  test("returns byok reasoning options for chatgpt-plus-pro gpt-5.5-fast", () => {
    const options = getReasoningTierOptionsForHandle(
      "chatgpt-plus-pro/gpt-5.5-fast",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.5-fast-plus-pro-none",
      "gpt-5.5-fast-plus-pro-low",
      "gpt-5.5-fast-plus-pro-medium",
      "gpt-5.5-fast-plus-pro-high",
      "gpt-5.5-fast-plus-pro-xhigh",
    ]);
  });

  test("resolves Fast registry handles for supported local ChatGPT OAuth models", () => {
    expect(
      getChatGptFastRegistryHandleForModelHandle("openai-codex/gpt-5.5"),
    ).toBe("chatgpt-plus-pro/gpt-5.5-fast");
    expect(
      getChatGptFastRegistryHandleForModelHandle("openai-codex/gpt-5.4"),
    ).toBe("chatgpt-plus-pro/gpt-5.4-fast");
    expect(
      getChatGptFastRegistryHandleForModelHandle("chatgpt-plus-pro/gpt-5.5"),
    ).toBe("chatgpt-plus-pro/gpt-5.5-fast");
    expect(
      getChatGptFastRegistryHandleForModelHandle("openai-codex/gpt-5.5-fast"),
    ).toBeNull();
  });

  test("does not return reasoning options for synthetic local ChatGPT Fast handles", () => {
    expect(
      getReasoningTierOptionsForHandle("openai-codex/gpt-5.5-fast"),
    ).toEqual([]);
  });

  test("returns reasoning options for anthropic sonnet 4.6", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-sonnet-4-6",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "sonnet-4.6-no-reasoning",
      "sonnet-4.6-low",
      "sonnet-4.6-medium",
      "sonnet-4.6",
      "sonnet-4.6-xhigh",
    ]);
  });

  test("returns reasoning options for anthropic sonnet 5", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-sonnet-5",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "sonnet-5-no-reasoning",
      "sonnet-5-low",
      "sonnet-5-medium",
      "sonnet",
      "sonnet-5-xhigh",
    ]);
  });

  test("returns reasoning options for anthropic opus 4.6", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-6",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "opus-4.6-no-reasoning",
      "opus-4.6-low",
      "opus-4.6-medium",
      "opus-4.6-high",
      "opus-4.6-xhigh",
    ]);
  });

  test("returns reasoning options for anthropic opus 4.8", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-8",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "opus-4.8-low",
      "opus-4.8-medium",
      "opus", // featured entry uses high; wins first-seen dedup
      "opus-4.8-xhigh",
      "opus-4.8-max",
    ]);
  });

  test("returns reasoning options for anthropic fable 5", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-fable-5",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "fable-low",
      "fable-medium",
      "fable",
      "fable-xhigh",
      "fable-max",
    ]);
  });

  test("returns reasoning options for anthropic opus 4.7", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-7",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "opus-4.7-low",
      "opus-4.7-medium",
      "opus-4.7-high",
      "opus-4.7-xhigh",
      "opus-4.7-max",
    ]);
  });

  test("returns reasoning options for anthropic opus 4.5", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-5-20251101",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "opus-4.5-no-reasoning",
      "opus-4.5-low",
      "opus-4.5-medium",
      "opus-4.5",
    ]);
  });

  test("returns only 1M reasoning options when context_window specified for opus", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-8",
      950000,
    );
    for (const option of options) {
      expect(option.modelId).toContain("1m");
    }
  });

  test("returns only 200k reasoning options when no context_window for opus", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-8",
    );
    for (const option of options) {
      expect(option.modelId).not.toContain("1m");
    }
  });

  test("returns generic reasoning options for discovered Ollama models", () => {
    const options = getReasoningTierOptionsForHandle("ollama/gpt-oss:20b");
    expect(options).toEqual([
      { effort: "none", modelId: "ollama/gpt-oss:20b" },
      { effort: "low", modelId: "ollama/gpt-oss:20b" },
      { effort: "medium", modelId: "ollama/gpt-oss:20b" },
      { effort: "high", modelId: "ollama/gpt-oss:20b" },
    ]);
  });

  test("returns empty options for models without reasoning tiers", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-haiku-4-5",
    );
    expect(options).toEqual([]);
  });
});

describe("shouldPreserveContextWindowForModelSelection", () => {
  test("preserves manual context when switching reasoning tiers on the same preset", () => {
    expect(
      shouldPreserveContextWindowForModelSelection({
        currentModelHandle: "openai/gpt-5.5",
        currentModelId: "gpt-5.5-high",
        currentLlmConfig: {
          model: "gpt-5.5",
          model_endpoint_type: "openai",
          context_window: 500000,
        },
        selectedModelHandle: "openai/gpt-5.5",
        selectedContextWindow: 272000,
      }),
    ).toBe(true);
  });

  test("does not preserve context when selecting a different context-window preset", () => {
    expect(
      shouldPreserveContextWindowForModelSelection({
        currentModelHandle: "anthropic/claude-sonnet-4-6",
        currentModelId: "sonnet",
        currentLlmConfig: {
          model: "claude-sonnet-4-6",
          model_endpoint_type: "anthropic",
          context_window: 500000,
        },
        selectedModelHandle: "anthropic/claude-sonnet-4-6",
        selectedContextWindow: 9500000,
      }),
    ).toBe(false);
  });

  test("normalizes ChatGPT OAuth llm_config handles before comparison", () => {
    expect(
      shouldPreserveContextWindowForModelSelection({
        currentModelId: "gpt-5.5-plus-pro-high",
        currentLlmConfig: {
          model: "gpt-5.5",
          model_endpoint_type: "chatgpt_oauth",
          context_window: 500000,
        },
        selectedModelHandle: "chatgpt-plus-pro/gpt-5.5",
        selectedContextWindow: 272000,
      }),
    ).toBe(true);
  });

  test("derives current preset from llm config when no current model id is available", () => {
    expect(
      shouldPreserveContextWindowForModelSelection({
        currentLlmConfig: {
          model: "gpt-5.5",
          model_endpoint_type: "openai",
          reasoning_effort: "high",
          context_window: 500000,
        },
        selectedModelHandle: "openai/gpt-5.5",
        selectedContextWindow: 272000,
      }),
    ).toBe(true);
  });
});
