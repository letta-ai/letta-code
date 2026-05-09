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
  test("wraps highlighted user content in erase-to-line-end padding rows", () => {
    const colorAnsi = "\x1b[48;2;45;45;45m";
    const eraseToEndOfLine = "\x1b[K";
    const lines = renderBlock("hello world", 22, true, colorAnsi, "> ", "  ");

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith(colorAnsi))).toBe(true);
    expect(lines[0]).toBe(`${colorAnsi}${eraseToEndOfLine}\x1b[0m`);
    expect(stripAnsi(lines[1] ?? "")).toBe("> hello world");
    expect(lines[1]?.endsWith(`${colorAnsi}${eraseToEndOfLine}\x1b[0m`)).toBe(
      true,
    );
    expect(lines[2]).toBe(`${colorAnsi}${eraseToEndOfLine}\x1b[0m`);
  });

  test("keeps unhighlighted blocks compact", () => {
    const lines = renderBlock(
      "system context",
      22,
      false,
      "\x1b[48;2;45;45;45m",
      "> ",
      "  ",
    );

    expect(lines).toEqual(["> system context"]);
  });
});
