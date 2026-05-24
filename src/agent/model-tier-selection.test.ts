import { describe, expect, test } from "bun:test";

import {
  getModelInfo,
  getModelInfoForLlmConfig,
  getReasoningTierOptionsForHandle,
  shouldPreserveContextWindowForModelSelection,
} from "@/agent/model";

describe("getModelInfo", () => {
  test("includes Bedrock Opus 4.7", () => {
    const info = getModelInfo("bedrock-opus-4.7");
    expect(info?.handle).toBe("bedrock/us.anthropic.claude-opus-4-7");
    expect(info?.label).toBe("Bedrock Opus 4.7");
    expect(info?.updateArgs).toMatchObject({
      context_window: 200000,
      reasoning_effort: "medium",
      enable_reasoner: true,
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

  test("falls back to first handle match when effort missing", () => {
    const handle = "openai/gpt-5.4";
    const info = getModelInfoForLlmConfig(handle, null);
    // models.json order currently lists gpt-5.4-none first.
    expect(info?.id).toBe("gpt-5.4-none");
  });

  test("selects opus 1M variant by context_window", () => {
    const handle = "anthropic/claude-opus-4-6";

    const withEffort = getModelInfoForLlmConfig(handle, {
      context_window: 950000,
      reasoning_effort: "high",
    });
    expect(withEffort?.id).toBe("opus-1m");

    // With 1M context_window but no effort → still a 1M variant (not 200k "opus")
    const noEffort = getModelInfoForLlmConfig(handle, {
      context_window: 950000,
    });
    expect(noEffort?.id).not.toBe("opus");
    expect(
      (noEffort?.updateArgs as { context_window?: number })?.context_window,
    ).toBe(950000);
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

  test("returns byok reasoning options for chatgpt-plus-pro gpt-5.3-codex", () => {
    const options = getReasoningTierOptionsForHandle(
      "chatgpt-plus-pro/gpt-5.3-codex",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.3-codex-plus-pro-none",
      "gpt-5.3-codex-plus-pro-low",
      "gpt-5.3-codex-plus-pro-medium",
      "gpt-5.3-codex-plus-pro-high",
      "gpt-5.3-codex-plus-pro-xhigh",
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
      "sonnet",
      "sonnet-4.6-xhigh",
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
      "opus", // featured entry uses medium; wins first-seen dedup
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
      "anthropic/claude-opus-4-6",
      950000,
    );
    for (const option of options) {
      expect(option.modelId).toContain("1m");
    }
  });

  test("returns only 200k reasoning options when no context_window for opus", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-opus-4-6",
    );
    for (const option of options) {
      expect(option.modelId).not.toContain("1m");
    }
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
