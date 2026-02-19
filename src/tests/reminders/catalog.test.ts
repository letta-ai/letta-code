import { describe, expect, test } from "bun:test";
import {
  SHARED_REMINDER_CATALOG,
  SHARED_REMINDER_IDS,
} from "../../reminders/catalog";
import {
  assertSharedReminderCoverage,
  sharedReminderProviders,
} from "../../reminders/engine";

describe("shared reminder catalog", () => {
  test("provider coverage matches catalog", () => {
    expect(() => assertSharedReminderCoverage()).not.toThrow();
  });

  test("catalog ids are unique", () => {
    const unique = new Set(SHARED_REMINDER_IDS);
    expect(unique.size).toBe(SHARED_REMINDER_IDS.length);
  });

  test("every runtime mode has at least one reminder", () => {
    const modes: Array<
      "interactive" | "headless-one-shot" | "headless-bidirectional"
    > = ["interactive", "headless-one-shot", "headless-bidirectional"];

    for (const mode of modes) {
      expect(SHARED_REMINDER_CATALOG.some((entry) => entry.modes.includes(mode)))
        .toBe(true);
    }
  });

  test("command and toolset reminders are interactive-only", () => {
    const commandReminder = SHARED_REMINDER_CATALOG.find(
      (entry) => entry.id === "command-io",
    );
    const toolsetReminder = SHARED_REMINDER_CATALOG.find(
      (entry) => entry.id === "toolset-change",
    );
    expect(commandReminder?.modes).toEqual(["interactive"]);
    expect(toolsetReminder?.modes).toEqual(["interactive"]);
  });

  test("provider ids and catalog ids stay in lockstep", () => {
    expect(Object.keys(sharedReminderProviders).sort()).toEqual(
      [...SHARED_REMINDER_IDS].sort(),
    );
  });
});
