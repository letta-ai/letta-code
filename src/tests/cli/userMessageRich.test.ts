import { describe, expect, test } from "bun:test";
import { splitSystemReminderBlocks } from "../../cli/components/UserMessageRich";

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
});
