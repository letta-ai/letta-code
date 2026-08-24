import { describe, expect, test } from "bun:test";
import {
  catalogHasDistinctMaxTier,
  formatXhighEffortLabel,
} from "@/agent/reasoning-effort-label";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();

describe("catalogHasDistinctMaxTier", () => {
  test("is true for GPT-5.6 Sol ChatGPT which has a max tier", () => {
    expect(
      catalogHasDistinctMaxTier({
        modelLabel: "GPT-5.6 Sol (ChatGPT)",
        modelHandle: "chatgpt-plus-pro/gpt-5.6-sol",
      }),
    ).toBe(true);
  });

  test("is false for Opus 4.6 which only exposes xhigh", () => {
    expect(
      catalogHasDistinctMaxTier({
        modelLabel: "Opus 4.6",
        modelHandle: "anthropic/claude-opus-4-6",
      }),
    ).toBe(false);
  });

  test("is true for Fable 5 and Opus 4.7+ which have a max tier", () => {
    expect(catalogHasDistinctMaxTier({ modelLabel: "Fable 5" })).toBe(true);
    expect(catalogHasDistinctMaxTier({ modelLabel: "Opus 4.7" })).toBe(true);
    expect(catalogHasDistinctMaxTier({ modelLabel: "Opus 4.8" })).toBe(true);
  });
});

describe("formatXhighEffortLabel", () => {
  test("uses Extra High when max is a distinct tier", () => {
    expect(formatXhighEffortLabel(true)).toBe("Extra High");
  });

  test("uses Max when xhigh is the top tier", () => {
    expect(formatXhighEffortLabel(false)).toBe("Max");
  });
});
