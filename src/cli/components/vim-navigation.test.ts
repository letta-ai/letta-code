import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readComponent(name: string): string {
  const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return readFileSync(path, "utf-8");
}

describe("vim-style j/k navigation in list selectors", () => {
  // Pure-list pickers (no inline text field), so binding bare j/k as
  // down/up aliases cannot clash with typing. Filter-based selectors
  // (AgentSelector, ProviderSelector, ...) deliberately avoid bare
  // letter shortcuts and are intentionally excluded here.
  const pickers = ["SingleSelectPicker.tsx", "MultiSelectPicker.tsx"];

  for (const picker of pickers) {
    test(`${picker} maps "k" to up and "j" to down`, () => {
      const source = readComponent(picker);
      expect(source).toContain('key.upArrow || input === "k"');
      expect(source).toContain('key.downArrow || input === "j"');
    });
  }
});
