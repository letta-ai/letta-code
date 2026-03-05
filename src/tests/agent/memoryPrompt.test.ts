import { describe, expect, test } from "bun:test";

import {
  composeSystemPrompt,
  recomposeMemoryAddon,
  stripMemoryAddon,
} from "../../agent/composeSystemPrompt";
import {
  SYSTEM_PROMPT_MEMFS_ADDON,
  SYSTEM_PROMPT_MEMORY_ADDON,
} from "../../agent/promptAssets";

describe("stripMemoryAddon", () => {
  test("strips standard memory addon cleanly", () => {
    const base = "You are a test agent.";
    const full = `${base}\n\n${SYSTEM_PROMPT_MEMORY_ADDON.trimStart()}`;

    const stripped = stripMemoryAddon(full);
    expect(stripped).toBe(base);
  });

  test("strips memfs memory addon cleanly", () => {
    const base = "You are a test agent.";
    const full = `${base}\n\n${SYSTEM_PROMPT_MEMFS_ADDON.trimStart()}`;

    const stripped = stripMemoryAddon(full);
    expect(stripped).toBe(base);
  });

  test("handles prompt with no memory section (returns as-is)", () => {
    const noMemory = "You are a test agent.\n\nSome other instructions.";
    const stripped = stripMemoryAddon(noMemory);
    expect(stripped).toBe(noMemory.trimEnd());
  });
});

describe("composeSystemPrompt", () => {
  test("produces correct output for standard mode", async () => {
    const base = "You are a test agent.";
    const result = await composeSystemPrompt({
      customPrompt: base,
      memoryMode: "standard",
    });

    expect(result).toContain(base);
    expect(result).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(result).not.toContain("## Memory Filesystem");
  });

  test("produces correct output for memfs mode", async () => {
    const base = "You are a test agent.";
    const result = await composeSystemPrompt({
      customPrompt: base,
      memoryMode: "memfs",
    });

    expect(result).toContain(base);
    expect(result).toContain("## Memory Filesystem");
    expect(result).not.toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
  });

  test("appends additional text when provided", async () => {
    const base = "You are a test agent.";
    const append = "Extra instructions here.";
    const result = await composeSystemPrompt({
      customPrompt: base,
      memoryMode: "standard",
      append,
    });

    expect(result).toEndWith(append);
  });
});

describe("recomposeMemoryAddon", () => {
  test("swaps from standard to memfs cleanly", () => {
    const base = "You are a test agent.";
    const standard = `${base}\n\n${SYSTEM_PROMPT_MEMORY_ADDON.trimStart()}`;

    const recomposed = recomposeMemoryAddon(standard, "memfs");

    expect(recomposed).toContain("## Memory Filesystem");
    expect(recomposed).not.toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
  });

  test("swaps from memfs to standard cleanly", () => {
    const base = "You are a test agent.";
    const memfs = `${base}\n\n${SYSTEM_PROMPT_MEMFS_ADDON.trimStart()}`;

    const recomposed = recomposeMemoryAddon(memfs, "standard");

    expect(recomposed).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(recomposed).not.toContain("## Memory Filesystem");
    expect(recomposed).not.toContain("# See what changed");
  });

  test("composition is idempotent", () => {
    const base = "You are a test agent.";
    const once = recomposeMemoryAddon(base, "memfs");
    const twice = recomposeMemoryAddon(once, "memfs");

    expect(twice).toBe(once);
  });
});
