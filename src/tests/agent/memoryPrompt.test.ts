import { describe, expect, test } from "bun:test";

import {
  buildSystemPrompt,
  isKnownPreset,
  resolveAndBuildSystemPrompt,
  SYSTEM_PROMPTS,
  shouldRecommendDefaultPrompt,
} from "../../agent/promptAssets";

describe("isKnownPreset", () => {
  test("returns true for known preset IDs", () => {
    expect(isKnownPreset("default")).toBe(true);
    expect(isKnownPreset("letta")).toBe(true);
    expect(isKnownPreset("source-claude")).toBe(true);
  });

  test("returns false for unknown IDs", () => {
    expect(isKnownPreset("recall")).toBe(false);
    expect(isKnownPreset("nonexistent")).toBe(false);
    // Old IDs should no longer be known
    expect(isKnownPreset("letta-claude")).toBe(false);
    expect(isKnownPreset("claude")).toBe(false);
  });
});

describe("buildSystemPrompt", () => {
  test("returns the standard full prompt for standard memory mode", () => {
    const result = buildSystemPrompt("letta", "standard");
    const preset = SYSTEM_PROMPTS.find((p) => p.id === "letta");
    expect(preset).toBeDefined();

    expect(result).toBe(preset?.content.trim() ?? "");
    expect(result).toContain("**In-context memory blocks**");
    expect(result).not.toContain("$MEMORY_DIR");
    expect(result).not.toContain("MemFS");
  });

  test("returns the memfs full prompt for memfs memory mode", () => {
    const result = buildSystemPrompt("letta", "memfs");
    const preset = SYSTEM_PROMPTS.find((p) => p.id === "letta");
    expect(preset).toBeDefined();
    expect(preset?.memfsContent).toBeDefined();

    expect(result).toBe(preset?.memfsContent?.trim() ?? "");
    expect(result).toContain("MemFS");
    expect(result).toContain("$MEMORY_DIR");
    expect(result).not.toContain("**In-context memory blocks**");
  });

  test("throws on unknown preset", () => {
    expect(() => buildSystemPrompt("unknown-id", "standard")).toThrow(
      'Unknown preset "unknown-id"',
    );
  });

  test("is idempotent — same inputs always produce same output", () => {
    const first = buildSystemPrompt("default", "memfs");
    const second = buildSystemPrompt("default", "memfs");
    expect(first).toBe(second);
  });

  test("default and letta presets resolve to same content in both memory modes", () => {
    expect(buildSystemPrompt("default", "standard")).toBe(
      buildSystemPrompt("letta", "standard"),
    );
    expect(buildSystemPrompt("default", "memfs")).toBe(
      buildSystemPrompt("letta", "memfs"),
    );
  });

  test("presets without a memfs variant are treated as complete prompts", () => {
    expect(buildSystemPrompt("source-claude", "memfs")).toBe(
      buildSystemPrompt("source-claude", "standard"),
    );
  });
});

describe("resolveAndBuildSystemPrompt", () => {
  test("returns known presets without appending memory sections", async () => {
    const standard = await resolveAndBuildSystemPrompt("letta", "standard");
    const memfs = await resolveAndBuildSystemPrompt("letta", "memfs");

    expect(standard).toBe(buildSystemPrompt("letta", "standard"));
    expect(memfs).toBe(buildSystemPrompt("letta", "memfs"));
  });
});

describe("shouldRecommendDefaultPrompt", () => {
  test("returns false when prompt matches current default (standard)", () => {
    const current = buildSystemPrompt("default", "standard");
    expect(shouldRecommendDefaultPrompt(current, "standard")).toBe(false);
  });

  test("returns false when prompt matches current default (memfs)", () => {
    const current = buildSystemPrompt("default", "memfs");
    expect(shouldRecommendDefaultPrompt(current, "memfs")).toBe(false);
  });

  test("returns true for a different preset", () => {
    const current = buildSystemPrompt("source-claude", "standard");
    expect(shouldRecommendDefaultPrompt(current, "standard")).toBe(true);
  });

  test("returns true for a fully custom prompt", () => {
    expect(
      shouldRecommendDefaultPrompt("You are a custom agent.", "standard"),
    ).toBe(true);
  });

  test("returns true for a modified default prompt", () => {
    const current = buildSystemPrompt("default", "standard");
    const modified = `${current}\n\nExtra instructions added by user.`;
    expect(shouldRecommendDefaultPrompt(modified, "standard")).toBe(true);
  });
});
