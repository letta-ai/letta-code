import { describe, expect, test } from "bun:test";

import {
  detectMemoryPromptDrift,
  reconcileMemoryPrompt,
} from "../../agent/memoryPrompt";
import {
  SYSTEM_PROMPT_MEMFS_ADDON,
  SYSTEM_PROMPT_MEMORY_ADDON,
} from "../../agent/promptAssets";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe("memoryPrompt reconciler", () => {
  test("replaces existing standard memory section with memfs section", () => {
    const base = "You are a test agent.";
    const standard = `${base}\n\n${SYSTEM_PROMPT_MEMORY_ADDON.trimStart()}`;

    const reconciled = reconcileMemoryPrompt(standard, "memfs");

    expect(reconciled).toContain("## Memory Filesystem");
    expect(reconciled).not.toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(countOccurrences(reconciled, "## Memory Filesystem")).toBe(1);
  });

  test("does not leave orphan memfs sync fragment when switching from memfs to standard", () => {
    const base = "You are a test agent.";
    const memfs = `${base}\n\n${SYSTEM_PROMPT_MEMFS_ADDON.trimStart()}`;

    const reconciled = reconcileMemoryPrompt(memfs, "standard");

    expect(reconciled).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(reconciled).not.toContain("## Memory Filesystem");
    expect(reconciled).not.toContain("# See what changed");
    expect(reconciled).not.toContain('git commit -m "<type>: <what changed>"');
  });

  test("cleans orphan memfs tail fragment before rebuilding target mode", () => {
    const tailStart = SYSTEM_PROMPT_MEMFS_ADDON.indexOf("# See what changed");
    expect(tailStart).toBeGreaterThanOrEqual(0);
    const orphanTail = SYSTEM_PROMPT_MEMFS_ADDON.slice(tailStart).trim();

    const drifted = `Header text\n\n${orphanTail}`;
    const drifts = detectMemoryPromptDrift(drifted, "standard");
    expect(drifts.some((d) => d.code === "orphan_memfs_fragment")).toBe(true);

    const reconciled = reconcileMemoryPrompt(drifted, "standard");
    expect(reconciled).toContain(
      "Your memory consists of core memory (composed of memory blocks)",
    );
    expect(reconciled).not.toContain("# See what changed");
  });

  test("memfs reconciliation is idempotent and keeps single syncing section", () => {
    const base = "You are a test agent.";
    const once = reconcileMemoryPrompt(base, "memfs");
    const twice = reconcileMemoryPrompt(once, "memfs");

    expect(twice).toBe(once);
    expect(countOccurrences(twice, "## Syncing")).toBe(1);
    expect(countOccurrences(twice, "# See what changed")).toBe(1);
  });
});
