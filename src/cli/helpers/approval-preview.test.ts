import { expect, test } from "bun:test";
import { countPreviewRows, fitPreviewLines } from "./approval-preview";

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`);

test("counts wrapped rows per line", () => {
  expect(countPreviewRows(["", "abcd", "abcdefghi"], 4)).toBe(1 + 1 + 3);
});

test("returns lines unchanged when they fit", () => {
  const lines = numbered(5);
  expect(fitPreviewLines(lines, 5, 80)).toBe(lines);
});

test("keeps the leading lines within the row budget, marker included", () => {
  const shown = fitPreviewLines(numbered(40), 10, 80);
  expect(shown).toEqual([...numbered(9), "… (31 more lines)"]);
});

test("counts wrapped rows against the budget", () => {
  const shown = fitPreviewLines(["x".repeat(30), "short", "tail"], 3, 10);
  expect(shown).toEqual(["… (3 more lines)"]);
  expect(fitPreviewLines(["x".repeat(20), "short", "tail"], 3, 10)).toEqual([
    "x".repeat(20),
    "… (2 more lines)",
  ]);
});

test("applies the line cap and counts every dropped line", () => {
  expect(fitPreviewLines(numbered(50), 100, 80, 40)).toEqual([
    ...numbered(40),
    "… (10 more lines)",
  ]);
});
