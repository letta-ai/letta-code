import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import {
  renderBlock,
  splitSystemReminderBlocks,
} from "../../cli/components/UserMessageRich";

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

describe("renderBlock", () => {
  test("wraps highlighted user content in full-width padding rows", () => {
    const colorAnsi = "\x1b[48;2;45;45;45m";
    const columns = 24;
    const lines = renderBlock(
      "hello world",
      22,
      columns,
      true,
      colorAnsi,
      "> ",
      "  ",
    );

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith(colorAnsi))).toBe(true);
    expect(stripAnsi(lines[0] ?? "")).toBe(" ".repeat(columns));
    expect(stripAnsi(lines[1] ?? "")).toBe(
      `> hello world${" ".repeat(columns - "> hello world".length)}`,
    );
    expect(stripAnsi(lines[2] ?? "")).toBe(" ".repeat(columns));
  });

  test("keeps unhighlighted blocks compact", () => {
    const lines = renderBlock(
      "system context",
      22,
      24,
      false,
      "\x1b[48;2;45;45;45m",
      "> ",
      "  ",
    );

    expect(lines).toEqual(["> system context"]);
  });
});
