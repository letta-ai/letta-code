import { describe, expect, test } from "bun:test";
import {
  buildExtensionCommandPrompt,
  normalizeExtensionCommandResult,
  parseExtensionCommandArgv,
  parseExtensionSlashCommand,
} from "@/cli/extensions/command-runtime";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

describe("extension command runtime", () => {
  test("parses slash command input", () => {
    expect(parseExtensionSlashCommand("/review current diff")).toEqual({
      command: "review",
      args: "current diff",
    });
    expect(parseExtensionSlashCommand("review current diff")).toBeNull();
    expect(parseExtensionSlashCommand("/")).toBeNull();
    expect(parseExtensionSlashCommand("//bad")).toBeNull();
  });

  test("splits extension command argv", () => {
    expect(parseExtensionCommandArgv('one "two words" three\\ four')).toEqual([
      "one",
      "two words",
      "three four",
    ]);
  });

  test("normalizes declarative command results", () => {
    expect(
      normalizeExtensionCommandResult({ type: "output", output: "done" }),
    ).toEqual({ type: "output", output: "done" });
    expect(() => normalizeExtensionCommandResult({ type: "prompt" })).toThrow(
      "prompt result requires content",
    );
  });

  test("wraps prompt results as system reminders by default", () => {
    expect(buildExtensionCommandPrompt({ content: "Review this" })).toBe(
      `${SYSTEM_REMINDER_OPEN}\nReview this\n${SYSTEM_REMINDER_CLOSE}`,
    );
    expect(
      buildExtensionCommandPrompt({
        content: "Review this",
        systemReminder: false,
      }),
    ).toBe("Review this");
  });
});
