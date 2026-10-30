import { describe, expect, test } from "bun:test";
import initializingMemory from "@/skills/builtin/initializing-memory/SKILL.md";
import maintainingCoreMemory from "@/skills/builtin/maintaining-core-memory/SKILL.md";
import maintainingDeferredMemory from "@/skills/builtin/maintaining-deferred-memory/SKILL.md";
import managingSharedMemory from "@/skills/builtin/managing-shared-memory/SKILL.md";

const HEADING = "## Commit memory changes\n";

/** The commit-format section, from its heading to the next `## ` heading. */
function commitSection(skill: string): string {
  const start = skill.indexOf(HEADING);
  if (start === -1) return "";
  const next = skill.indexOf("\n## ", start + HEADING.length);
  return skill.slice(start, next === -1 ? undefined : next).trimEnd();
}

describe("memory commit format", () => {
  const copies = {
    "maintaining-core-memory": maintainingCoreMemory,
    "maintaining-deferred-memory": maintainingDeferredMemory,
    "initializing-memory": initializingMemory,
    "managing-shared-memory": managingSharedMemory,
  };
  const canonical = commitSection(maintainingCoreMemory);

  test("every memory-writing skill carries the identical section", () => {
    expect(canonical).not.toBe("");
    for (const [name, skill] of Object.entries(copies)) {
      expect({ name, section: commitSection(skill) }).toEqual({
        name,
        section: canonical,
      });
    }
  });
});
