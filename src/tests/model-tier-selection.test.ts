import { describe, expect, test } from "bun:test";

import {
  getModelInfoForLlmConfig,
  getReasoningTierOptionsForHandle,
} from "../agent/model";

describe("getModelInfoForLlmConfig", () => {
  test("selects gpt-5.2 tier by reasoning_effort", () => {
    const handle = "openai/gpt-5.2";

    const high = getModelInfoForLlmConfig(handle, { reasoning_effort: "high" });
    expect(high?.id).toBe("gpt-5.2-high");

    const none = getModelInfoForLlmConfig(handle, { reasoning_effort: "none" });
    expect(none?.id).toBe("gpt-5.2-none");

    const xhigh = getModelInfoForLlmConfig(handle, {
      reasoning_effort: "xhigh",
    });
    expect(xhigh?.id).toBe("gpt-5.2-xhigh");
  });

  test("falls back to first handle match when effort missing", () => {
    const handle = "openai/gpt-5.2";
    const info = getModelInfoForLlmConfig(handle, null);
    // models.json order currently lists gpt-5.2-none first.
    expect(info?.id).toBe("gpt-5.2-none");
  });
});

describe("getReasoningTierOptionsForHandle", () => {
  test("returns ordered reasoning options for gpt-5.2-codex", () => {
    const options = getReasoningTierOptionsForHandle("openai/gpt-5.2-codex");
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "gpt-5.2-codex-none",
      "gpt-5.2-codex-low",
      "gpt-5.2-codex-medium",
      "gpt-5.2-codex-high",
      "gpt-5.2-codex-xhigh",
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

  test("returns reasoning options for anthropic sonnet 4.6", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-sonnet-4-6",
    );
    expect(options.map((option) => option.effort)).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "sonnet-4.6-no-reasoning",
      "sonnet-4.6-low",
      "sonnet-4.6-medium",
      "sonnet",
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
    ]);
    expect(options.map((option) => option.modelId)).toEqual([
      "opus-4.6-no-reasoning",
      "opus-4.6-low",
      "opus-4.6-medium",
      "opus",
    ]);
  });

  test("returns empty options for models without reasoning tiers", () => {
    const options = getReasoningTierOptionsForHandle(
      "anthropic/claude-haiku-4-5-20251001",
    );
    expect(options).toEqual([]);
  });
});
