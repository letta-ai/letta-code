import { describe, expect, test } from "bun:test";

import {
  buildSystemPrompt,
  isKnownPreset,
  SYSTEM_PROMPT_BLOCKS_ADDON,
  SYSTEM_PROMPT_MEMFS_ADDON,
  shouldRecommendDefaultPrompt,
  swapMemoryAddon,
} from "../../agent/promptAssets";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe("isKnownPreset", () => {
  test("returns true for known preset IDs", () => {
    expect(isKnownPreset("default")).toBe(true);
    expect(isKnownPreset("letta")).toBe(true);
    expect(isKnownPreset("source-claude")).toBe(true);
  });

  test("returns false for unknown IDs", () => {
    expect(isKnownPreset("explore")).toBe(false);
    expect(isKnownPreset("nonexistent")).toBe(false);
    // Old IDs should no longer be known
    expect(isKnownPreset("letta-claude")).toBe(false);
    expect(isKnownPreset("claude")).toBe(false);
  });
});

describe("buildSystemPrompt", () => {
  test("builds standard prompt with memory addon", () => {
    const result = buildSystemPrompt("letta", "standard");
    expect(result).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(result).not.toContain("## Memory structure");
  });

  test("builds memfs prompt with memfs addon", () => {
    const result = buildSystemPrompt("letta", "memfs");
    expect(result).toContain("## Memory structure");
    expect(result).not.toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
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

  test("default and letta presets resolve to same content", () => {
    const defaultResult = buildSystemPrompt("default", "standard");
    const lettaResult = buildSystemPrompt("letta", "standard");
    expect(defaultResult).toBe(lettaResult);
  });
});

describe("swapMemoryAddon", () => {
  test("swaps standard to memfs", () => {
    const base = "You are a test agent.";
    const standard = `${base}\n\n${SYSTEM_PROMPT_BLOCKS_ADDON.trimStart()}`;

    const result = swapMemoryAddon(standard, "memfs");

    expect(result).toContain("## Memory structure");
    expect(result).not.toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(countOccurrences(result, "## Memory structure")).toBe(1);
  });

  test("swaps memfs to standard without orphan fragments", () => {
    const base = "You are a test agent.";
    const memfs = `${base}\n\n${SYSTEM_PROMPT_MEMFS_ADDON.trimStart()}`;

    const result = swapMemoryAddon(memfs, "standard");

    expect(result).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(result).not.toContain("## Memory structure");
    expect(result).not.toContain("# See what changed");
    expect(result).not.toContain('git commit -m "<type>: <what changed>"');
  });

  test("handles duplicate addons", () => {
    const base = "You are a test agent.";
    const doubled = `${base}\n\n${SYSTEM_PROMPT_BLOCKS_ADDON}\n\n${SYSTEM_PROMPT_BLOCKS_ADDON}`;

    const result = swapMemoryAddon(doubled, "memfs");

    expect(countOccurrences(result, "## Memory structure")).toBe(1);
    expect(result).not.toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
  });

  test("strips orphan memfs tail fragment", () => {
    const tailStart = SYSTEM_PROMPT_MEMFS_ADDON.indexOf("# See what changed");
    expect(tailStart).toBeGreaterThanOrEqual(0);
    const orphanTail = SYSTEM_PROMPT_MEMFS_ADDON.slice(tailStart).trim();

    const drifted = `Header text\n\n${orphanTail}`;
    const result = swapMemoryAddon(drifted, "standard");

    expect(result).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(result).not.toContain("# See what changed");
  });

  test("strips legacy heading-based ## Memory section", () => {
    const legacy =
      "You are a test agent.\n\n## Memory\nLegacy memory instructions here.\n\nSome other details.";

    const result = swapMemoryAddon(legacy, "memfs");

    expect(result).toContain("## Memory structure");
    expect(result).not.toContain("Legacy memory instructions");
    expect(countOccurrences(result, "## Memory structure")).toBe(1);
  });

  test("strips legacy heading-based ## Memory Filesystem section", () => {
    const legacy =
      "You are a test agent.\n\n## Memory Filesystem\nOld memfs instructions.";

    const result = swapMemoryAddon(legacy, "standard");

    expect(result).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(result).not.toContain("Old memfs instructions");
  });

  test("is idempotent", () => {
    const base = "You are a test agent.";
    const once = swapMemoryAddon(base, "memfs");
    const twice = swapMemoryAddon(once, "memfs");

    expect(twice).toBe(once);
    expect(countOccurrences(twice, "## Syncing")).toBe(1);
    expect(countOccurrences(twice, "# See what changed")).toBe(1);
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
