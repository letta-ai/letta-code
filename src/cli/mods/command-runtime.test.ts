import { describe, expect, test } from "bun:test";
import {
  buildModCommandPrompt,
  normalizeModCommandResult,
  parseModCommandArgv,
  parseModSlashCommand,
} from "@/cli/mods/command-runtime";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

describe("mod command runtime", () => {
  test("parses slash command input", () => {
    expect(parseModSlashCommand("/review current diff")).toEqual({
      command: "review",
      args: "current diff",
    });
    expect(parseModSlashCommand("review current diff")).toBeNull();
    expect(parseModSlashCommand("/")).toBeNull();
    expect(parseModSlashCommand("//bad")).toBeNull();
  });

  test("splits mod command argv", () => {
    expect(parseModCommandArgv('one "two words" three\\ four')).toEqual([
      "one",
      "two words",
      "three four",
    ]);
  });

  test("normalizes declarative command results", () => {
    expect(
      normalizeModCommandResult({ type: "output", output: "done" }),
    ).toEqual({ type: "output", output: "done" });
    expect(() => normalizeModCommandResult({ type: "prompt" })).toThrow(
      "prompt result requires content",
    );
  });

  test("wraps prompt results as system reminders by default", () => {
    expect(buildModCommandPrompt({ content: "Review this" })).toBe(
      `${SYSTEM_REMINDER_OPEN}\nReview this\n${SYSTEM_REMINDER_CLOSE}`,
    );
    expect(
      buildModCommandPrompt({
        content: "Review this",
        systemReminder: false,
      }),
    ).toBe("Review this");
  });
});
