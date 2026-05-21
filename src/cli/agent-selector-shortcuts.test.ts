import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("agent selector shortcuts", () => {
  test("uses Shift+D for delete so lowercase d can be typed in search", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain('} else if (input === "D") {');
    expect(source).not.toContain('input === "d" || input === "D"');

    const deleteShortcutIndex = source.indexOf('} else if (input === "D") {');
    const searchTypingIndex = source.indexOf(
      "// Type to search (cloud list tabs only",
    );

    expect(deleteShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(searchTypingIndex).toBeGreaterThan(deleteShortcutIndex);
    expect(source).toContain("Shift+D delete");
  });
});
