import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("agent selector shortcuts", () => {
  test("uses Shift+D for delete so lowercase d can be typed in search", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain('allowDelete && input === "D"');
    expect(source).not.toContain('input === "d" || input === "D"');

    const deleteShortcutIndex = source.indexOf('allowDelete && input === "D"');
    const searchTypingIndex = source.indexOf(
      '} else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {',
    );

    expect(deleteShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(searchTypingIndex).toBeGreaterThan(deleteShortcutIndex);
    expect(source).toContain("Shift+D delete");
  });
});
