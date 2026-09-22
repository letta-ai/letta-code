import { describe, expect, test } from "bun:test";
import {
  formatSystemReminderBlock,
  renderBlock,
  splitSystemReminderBlocks,
} from "@/cli/components/UserMessageRich";

describe("splitSystemReminderBlocks", () => {
  test("treats unmatched system-reminder opener as literal user text", () => {
    const text = "like the <system-reminder> etc included.";
    const blocks = splitSystemReminderBlocks(text);

    expect(blocks).toEqual([{ text, isSystemReminder: false }]);
  });

  test("still detects well-formed system-reminder blocks", () => {
    const blocks = splitSystemReminderBlocks(
      "before\n<system-reminder>\ncontext\n</system-reminder>\nafter",
    );

    expect(blocks.some((b) => b.isSystemReminder)).toBe(true);
    expect(blocks.some((b) => b.text.includes("before"))).toBe(true);
    expect(blocks.some((b) => b.text.includes("after"))).toBe(true);
  });

  test("detects legacy system-alert blocks as system context", () => {
    const blocks = splitSystemReminderBlocks(
      "before\n<system-alert>alert</system-alert>\nafter",
    );

    expect(blocks.some((b) => b.isSystemReminder)).toBe(true);
    expect(blocks.some((b) => b.text.includes("<system-alert>"))).toBe(true);
  });
});

describe("formatSystemReminderBlock", () => {
  const reminder =
    "<system-reminder>\nFirst instruction\nSecond instruction\n</system-reminder>";

  test("collapses reminder contents into a one-line summary by default", () => {
    expect(formatSystemReminderBlock(reminder, false)).toBe(
      "▸ System reminder · 2 lines (ctrl+r to expand)",
    );
  });

  test("preserves the complete reminder when expanded", () => {
    expect(formatSystemReminderBlock(reminder, true)).toBe(
      `▾ System reminder (ctrl+r to collapse)\n${reminder}`,
    );
  });
});

describe("renderBlock", () => {
  test("wraps highlighted user content in full-width padding rows", () => {
    const columns = 24;
    const lines = renderBlock("hello world", 22, columns, true, "> ", "  ");

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.highlighted)).toBe(true);
    expect(lines[0]?.text).toBe(" ".repeat(columns));
    expect(lines[1]?.text).toBe(
      `> hello world${" ".repeat(columns - "> hello world".length)}`,
    );
    expect(lines[2]?.text).toBe(" ".repeat(columns));
  });

  test("pads warning-sign rows using Ink width semantics", () => {
    const columns = 12;
    const lines = renderBlock("⚠ warn", 10, columns, true, "> ", "  ");

    expect(lines[1]?.text).toBe(`> ⚠ warn${" ".repeat(4)}`);
  });

  test("keeps unhighlighted blocks compact", () => {
    const lines = renderBlock("system context", 22, 24, false, "> ", "  ");

    expect(lines).toEqual([{ text: "> system context", highlighted: false }]);
  });

  test("hard-wraps long unbroken highlighted content with continuation indentation", () => {
    const columns = 12;
    const lines = renderBlock(
      "https://example.com/abcdef",
      10,
      columns,
      true,
      "> ",
      "  ",
    );

    expect(lines).toEqual([
      { text: " ".repeat(columns), highlighted: true },
      { text: "> https://ex", highlighted: true },
      { text: "  ample.com/", highlighted: true },
      { text: `  abcdef${" ".repeat(4)}`, highlighted: true },
      { text: " ".repeat(columns), highlighted: true },
    ]);
  });
});
