import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers, onChunk } from "../../cli/helpers/accumulator";

function usageChunk(
  fields: Record<string, number | null | undefined>,
): LettaStreamingResponse {
  return {
    message_type: "usage_statistics",
    ...fields,
  } as LettaStreamingResponse;
}

describe("accumulator usage statistics", () => {
  test("captures all LettaUsageStatistics token metrics", () => {
    const buffers = createBuffers();

    onChunk(
      buffers,
      usageChunk({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        step_count: 1,
        cached_input_tokens: 60,
        cache_write_tokens: 11,
        reasoning_tokens: 7,
        context_tokens: 512,
      }),
    );

    onChunk(
      buffers,
      usageChunk({
        prompt_tokens: 40,
        completion_tokens: 8,
        total_tokens: 48,
        step_count: 2,
        cached_input_tokens: 5,
        cache_write_tokens: 3,
        reasoning_tokens: 2,
        context_tokens: 640,
      }),
    );

    expect(buffers.usage.promptTokens).toBe(140);
    expect(buffers.usage.completionTokens).toBe(28);
    expect(buffers.usage.totalTokens).toBe(168);
    expect(buffers.usage.stepCount).toBe(3);
    expect(buffers.usage.cachedInputTokens).toBe(65);
    expect(buffers.usage.cacheWriteTokens).toBe(14);
    expect(buffers.usage.reasoningTokens).toBe(9);
    // context_tokens is a snapshot value, so we keep the latest one.
    expect(buffers.usage.contextTokens).toBe(640);
  });

  test("ignores null optional token metrics", () => {
    const buffers = createBuffers();

    onChunk(
      buffers,
      usageChunk({
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        context_tokens: null,
      }),
    );

    expect(buffers.usage.cachedInputTokens).toBe(0);
    expect(buffers.usage.cacheWriteTokens).toBe(0);
    expect(buffers.usage.reasoningTokens).toBe(0);
    expect(buffers.usage.contextTokens).toBeUndefined();
  });
});
