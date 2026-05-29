import { describe, expect, test } from "bun:test";
import { applyContextUsageSnapshot } from "./context-usage";
import type { ContextData } from "./types";

function breakdownTotal(context: ContextData): number {
  return Object.values(context.breakdown).reduce(
    (sum, tokens) => sum + tokens,
    0,
  );
}

describe("applyContextUsageSnapshot", () => {
  test("uses the latest payload context tokens over a stale estimate", () => {
    const context = applyContextUsageSnapshot(
      {
        contextWindow: 272_000,
        usedTokens: 318_000,
        model: "old-model",
        breakdown: {
          system: 18_000,
          coreMemory: 0,
          externalMemory: 0,
          summaryMemory: 0,
          tools: 0,
          messages: 300_000,
        },
      },
      {
        contextWindow: 272_000,
        usedTokens: 243_000,
        model: "chatgpt-plus-pro/gpt-5.5",
      },
    );

    expect(context?.usedTokens).toBe(243_000);
    expect(context?.contextWindow).toBe(272_000);
    expect(context?.model).toBe("chatgpt-plus-pro/gpt-5.5");
    expect(context ? breakdownTotal(context) : 0).toBe(243_000);
    expect(context?.breakdown.messages).toBeLessThan(300_000);
  });

  test("creates context data from a payload snapshot when no estimate exists", () => {
    const context = applyContextUsageSnapshot(undefined, {
      contextWindow: 200_000,
      usedTokens: 123_456,
      model: "anthropic/claude-sonnet-4-5",
    });

    expect(context).toEqual({
      contextWindow: 200_000,
      usedTokens: 123_456,
      model: "anthropic/claude-sonnet-4-5",
      breakdown: {
        system: 0,
        coreMemory: 0,
        externalMemory: 0,
        summaryMemory: 0,
        tools: 0,
        messages: 123_456,
      },
    });
  });

  test("keeps existing context when the payload snapshot is unavailable", () => {
    const existing: ContextData = {
      contextWindow: 272_000,
      usedTokens: 318_000,
      model: "old-model",
      breakdown: {
        system: 18_000,
        coreMemory: 0,
        externalMemory: 0,
        summaryMemory: 0,
        tools: 0,
        messages: 300_000,
      },
    };

    expect(applyContextUsageSnapshot(existing, undefined)).toBe(existing);
    expect(
      applyContextUsageSnapshot(existing, {
        contextWindow: 272_000,
        usedTokens: 0,
        model: "chatgpt-plus-pro/gpt-5.5",
      }),
    ).toBe(existing);
  });
});
