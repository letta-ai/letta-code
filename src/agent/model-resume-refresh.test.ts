import { describe, expect, test } from "bun:test";
import { getModelUpdateArgs, getResumeRefreshArgs } from "@/agent/model";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();

describe("getResumeRefreshArgs", () => {
  test("preserves an explicit output limit while refreshing parallel tool calls", () => {
    const result = getResumeRefreshArgs(
      {
        max_output_tokens: 128_000,
        parallel_tool_calls: true,
      },
      {
        llm_config: { max_tokens: 4_000 },
        model_settings: { parallel_tool_calls: false },
      },
    );

    expect(result).toEqual({
      updateArgs: { parallel_tool_calls: true },
      needsUpdate: true,
    });
  });

  test("does not patch when only the output limit differs", () => {
    const result = getResumeRefreshArgs(
      {
        max_output_tokens: 128_000,
        parallel_tool_calls: true,
      },
      {
        llm_config: { max_tokens: 4_000 },
        model_settings: { parallel_tool_calls: true },
      },
    );

    expect(result).toEqual({
      updateArgs: { parallel_tool_calls: true },
      needsUpdate: false,
    });
  });

  test("explicit model selection still includes the preset output limit", () => {
    expect(getModelUpdateArgs("gpt-5.4-medium")?.max_output_tokens).toBe(
      128_000,
    );
  });
});
